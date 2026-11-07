/**
 * This Mac's own numbers for the Machine key: CPU use per core cluster,
 * memory pressure and free disk space (plus the load average, for reference).
 * Nothing here talks to T3 Code; it reads the OS.
 *
 * Why CPU % and not the load average: on macOS the load average also counts
 * threads that are waiting rather than running, so it can sit at 40+ while
 * the CPUs are mostly idle. Busy time per core is what the CPUs actually did.
 *
 * Apple silicon mixes performance (P) and efficiency (E) cores. macOS puts
 * background work on the E cores, so they often look busy while the P cores,
 * the ones your builds and agents need, are free. The key's colour follows
 * the P cores; the E cores are shown beside them.
 *
 * Pure parts (levels, formatting, parsing) are exported for tests. The
 * monitor samples every few seconds, and only while a Machine key is on a deck.
 */
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { statfs } from "node:fs/promises";
import { cpus, homedir, loadavg, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";

export type MachineStat = "summary" | "cpu" | "memory" | "disk";

const STATS: ReadonlySet<string> = new Set(["summary", "cpu", "memory", "disk"]);
/** Key setting → stat. "load" was this key's name for the CPU stat before it measured CPU use. */
export const machineStatOf = (stat: string | undefined): MachineStat => (stat === "load" ? "cpu" : stat && STATS.has(stat) ? (stat as MachineStat) : "summary");

/** Healthy, getting tight, act now. */
export type Level = "ok" | "busy" | "high";

// ---------- CPU ----------

/** "P" and "E" on Apple silicon; "CPU" when all cores are alike (Intel, or the layout is unknown). */
export type ClusterKind = "P" | "E" | "CPU";

export interface CpuTopology {
	/** Short chip name: "M1 Max", "Core i9", or "CPU". */
	chip: string;
	/** Core indexes (as `os.cpus()` lists them) per cluster, P first. */
	clusters: { kind: ClusterKind; cpus: number[] }[];
}

export interface ClusterUsage {
	kind: ClusterKind;
	cores: number;
	/** Share of the time these cores were busy over the window, 0-100. */
	busy: number;
}

export interface CpuStats {
	chip: string;
	/** P first. */
	clusters: ClusterUsage[];
	/** How much time the percentages cover. */
	windowMs: number;
}

/** The cluster the key's colour and big number follow: P cores, or all cores. */
export const mainCluster = (c: CpuStats): ClusterUsage | undefined => c.clusters.find((k) => k.kind === "P") ?? c.clusters[0];

/** Over the averaging window: below 70% busy is headroom, 90% and up is maxed out. */
export function cpuLevel(busy: number): Level {
	return busy >= 90 ? "high" : busy >= 70 ? "busy" : "ok";
}

/** "Apple M1 Max" → "M1 Max"; "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz" → "Core i9". */
export function shortChip(model: string | undefined): string {
	const m = (model ?? "").trim();
	const apple = /^Apple\s+(M\d+(?:\s+(?:Pro|Max|Ultra))?)/i.exec(m);
	if (apple) return apple[1]!;
	const core = /Core\(TM\)\s+(i\d)/i.exec(m);
	if (core) return `Core ${core[1]}`;
	if (/Xeon/i.test(m)) return "Xeon";
	return "CPU";
}

/** "8P+2E", or "16 CORES" when the cores are all alike. */
export function coreLayout(c: { clusters: { kind: ClusterKind; cores?: number; cpus?: number[] }[] }): string {
	const count = (k: { cores?: number; cpus?: number[] }) => k.cores ?? k.cpus?.length ?? 0;
	if (c.clusters.length === 1) return `${count(c.clusters[0]!)} CORES`;
	return c.clusters.map((k) => `${count(k)}${k.kind}`).join("+");
}

/**
 * `ioreg -rd1 -c IOPlatformDevice` output → logical CPU id → "P" | "E".
 * Each `cpuN` node lists its `logical-cpu-id` and `cluster-type`.
 */
export function parseClusterTypes(output: string): Map<number, "P" | "E"> {
	const map = new Map<number, "P" | "E">();
	for (const block of output.split(/^\+-o /m)) {
		if (!/^cpu\d+@/.test(block)) continue;
		const id = /"logical-cpu-id" = (\d+)/.exec(block);
		const type = /"cluster-type" = <"([PE])">/.exec(block);
		if (id && type) map.set(Number(id[1]), type[1] as "P" | "E");
	}
	return map;
}

/**
 * Clusters for `count` cores: from ioreg's per-core cluster types when they
 * cover every core, else from the kernel's per-level counts (macOS numbers
 * E cores first), else one cluster of all cores.
 */
export function topologyFrom(model: string | undefined, count: number, types: Map<number, "P" | "E">, levels?: { p: number; e: number }): CpuTopology {
	const chip = shortChip(model);
	const all = Array.from({ length: count }, (_, i) => i);
	if (types.size === count && count > 0) {
		const p = all.filter((i) => types.get(i) === "P");
		const e = all.filter((i) => types.get(i) === "E");
		if (p.length > 0 && e.length > 0) return { chip, clusters: [{ kind: "P", cpus: p }, { kind: "E", cpus: e }] };
	}
	if (levels && levels.p > 0 && levels.e > 0 && levels.p + levels.e === count) {
		return { chip, clusters: [{ kind: "P", cpus: all.slice(levels.e) }, { kind: "E", cpus: all.slice(0, levels.e) }] };
	}
	return { chip, clusters: [{ kind: "CPU", cpus: all }] };
}

/** Cumulative busy and total time per core, as `os.cpus()` reports it (ms since boot). */
export type CpuTimes = { busy: number; total: number }[];

export function cpuTimes(list: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): CpuTimes {
	return list.map(({ times: t }) => {
		const busy = t.user + t.nice + t.sys + t.irq;
		return { busy, total: busy + t.idle };
	});
}

/** Busy share per cluster between two readings. Null when no time passed. */
export function cpuUsage(topology: CpuTopology, from: CpuTimes, to: CpuTimes, windowMs: number): CpuStats | null {
	const clusters: ClusterUsage[] = [];
	for (const c of topology.clusters) {
		let busy = 0;
		let total = 0;
		for (const i of c.cpus) {
			const a = from[i];
			const b = to[i];
			if (!a || !b) continue;
			busy += Math.max(0, b.busy - a.busy);
			total += Math.max(0, b.total - a.total);
		}
		if (total <= 0) return null;
		clusters.push({ kind: c.kind, cores: c.cpus.length, busy: Math.min(100, (100 * busy) / total) });
	}
	return { chip: topology.chip, clusters, windowMs };
}

// ---------- Memory and disk ----------

export interface MemoryStats {
	/** Kernel's "memory free percentage" (what `memory_pressure` prints): free plus reclaimable. */
	freePercent: number;
	/** Kernel memory pressure: 1 normal, 2 warning, 4 critical. Activity Monitor's green/yellow/red. */
	pressure?: number;
	totalBytes: number;
	swapUsedBytes?: number;
}

export interface DiskStats {
	totalBytes: number;
	/** Space a normal user can still write (statfs `bavail`). */
	freeBytes: number;
}

export interface MachineSnapshot {
	at: number;
	/** 1, 5 and 15 minute load averages, shown for reference only. */
	load: [number, number, number];
	/** Missing until two readings are far enough apart. */
	cpu?: CpuStats;
	/** Missing when the memory read failed. */
	memory?: MemoryStats;
	/** Disk path (as given in key settings, normalised) → stats, or why there are none. */
	disks: Map<string, DiskStats | { error: string }>;
}

/** The kernel's own pressure level when it reports one, else the free share. */
export function memoryLevel(m: MemoryStats): Level {
	if (m.pressure === 4) return "high";
	if (m.pressure === 2) return "busy";
	if (m.pressure === 1) return "ok";
	return m.freePercent < 10 ? "high" : m.freePercent < 25 ? "busy" : "ok";
}

const GB = 1e9;

/** Nearly full by share, or by what's left in absolute terms (a big disk at 96% still has room). */
export function diskLevel(d: DiskStats): Level {
	const used = usedPercent(d);
	if (used >= 95 || d.freeBytes < 10 * GB) return "high";
	if (used >= 90 || d.freeBytes < 25 * GB) return "busy";
	return "ok";
}

export const usedPercent = (d: DiskStats): number => (d.totalBytes > 0 ? Math.min(100, Math.max(0, 100 * (1 - d.freeBytes / d.totalBytes))) : 0);

/** Compact load average: "3.2", "21". */
export const formatLoadShort = (n: number): string => (n >= 10 ? String(Math.round(n)) : n.toFixed(1));

/** Decimal units, like Finder: "58 GB", "1.2 TB", "940 MB". */
export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let n = Math.max(0, bytes);
	let i = 0;
	// 999.6 GB would print as "1000 GB": move up a unit before rounding gets there.
	while (n >= 999.5 && i < units.length - 1) {
		n /= 1000;
		i++;
	}
	const digits = n >= 10 || i === 0 ? 0 : 1;
	return `${n.toFixed(digits)} ${units[i]}`;
}

/** Key settings path → absolute path: blank is "/", "~" is the home folder. */
export function normalizeDiskPath(input: string | undefined): string {
	const p = (input ?? "").trim();
	if (!p) return "/";
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** Tile title for a disk: "DISK" for the startup disk, else the last path part ("/Volumes/Backup" → "BACKUP"). */
export function diskTitle(path: string): string {
	if (path === "/" || path === "/System/Volumes/Data") return "DISK";
	const last = path.replace(/\/+$/, "").split("/").pop();
	return (last || "DISK").toUpperCase();
}

/** `sysctl -n kern.memorystatus_level kern.memorystatus_vm_pressure_level vm.swapusage` output. */
export function parseMemory(output: string, totalBytes: number): MemoryStats {
	const [levelLine, pressureLine, swapLine] = output.split("\n").map((l) => l.trim());
	const freePercent = Number(levelLine);
	if (!levelLine || !Number.isFinite(freePercent)) throw new Error(`unexpected sysctl output: ${JSON.stringify(output.slice(0, 80))}`);
	const pressure = Number(pressureLine);
	const swap = /used = ([\d.]+)([KMGT])/.exec(swapLine ?? "");
	const scale: Record<string, number> = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };
	return {
		freePercent: Math.min(100, Math.max(0, freePercent)),
		pressure: Number.isFinite(pressure) && pressureLine ? pressure : undefined,
		totalBytes,
		swapUsedBytes: swap ? Number(swap[1]) * scale[swap[2]!]! : undefined,
	};
}

// ---------- Reading the OS ----------

/** Where the numbers come from; swapped out in tests. */
export interface MachineReader {
	load(): [number, number, number];
	/** Cumulative per-core times, in `topology()`'s core order. */
	cpuTimes(): CpuTimes;
	topology(): Promise<CpuTopology>;
	memory(): Promise<MemoryStats>;
	disk(path: string): Promise<DiskStats>;
}

const SYSCTL = "/usr/sbin/sysctl";
const IOREG = "/usr/sbin/ioreg";
const CMD_TIMEOUT_MS = 3000;

/** Runs a fixed system command; resolves with stdout even when it exits non-zero (sysctl does for unknown names). */
function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: CMD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			if (error && !stdout) reject(error);
			else resolve(stdout);
		});
	});
}

/** `sysctl hw.perflevel0.name …` lines ("name: value") → P and E core counts. Undefined on Intel. */
export function parsePerfLevels(output: string): { p: number; e: number } | undefined {
	const v = new Map(output.split("\n").map((l) => l.split(/:\s*/, 2) as [string, string]).filter((kv) => kv.length === 2));
	const levels = Number(v.get("hw.nperflevels"));
	if (levels !== 2) return undefined;
	const counts: Record<string, number> = {};
	for (const n of [0, 1]) counts[v.get(`hw.perflevel${n}.name`) ?? ""] = Number(v.get(`hw.perflevel${n}.logicalcpu`));
	const p = counts.Performance;
	const e = counts.Efficiency;
	return p && e ? { p, e } : undefined;
}

async function readTopology(): Promise<CpuTopology> {
	const list = cpus();
	const [types, levels] = await Promise.all([
		run(IOREG, ["-rd1", "-c", "IOPlatformDevice"]).then(parseClusterTypes, () => new Map<number, "P" | "E">()),
		run(SYSCTL, ["hw.nperflevels", "hw.perflevel0.name", "hw.perflevel0.logicalcpu", "hw.perflevel1.name", "hw.perflevel1.logicalcpu"]).then(parsePerfLevels, () => undefined),
	]);
	return topologyFrom(list[0]?.model, list.length, types, levels);
}

export const systemReader: MachineReader = {
	load: () => loadavg() as [number, number, number],
	cpuTimes: () => cpuTimes(cpus()),
	topology: readTopology,
	memory: async () => parseMemory(await run(SYSCTL, ["-n", "kern.memorystatus_level", "kern.memorystatus_vm_pressure_level", "vm.swapusage"]), totalmem()),
	disk: async (path) => {
		if (!isAbsolute(path)) throw new Error("not an absolute path");
		const s = await statfs(path);
		return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
	},
};

/** How often the key's numbers update. */
export const SAMPLE_MS = 5000;
/** CPU % is the average over this long, so one short burst doesn't flip the colour. */
export const CPU_WINDOW_MS = 30_000;
/** After the very first reading, the next comes this soon so CPU % shows up quickly. */
const FIRST_GAP_MS = 1000;

/** Why a disk can't be read, in a few words for the key. */
function diskError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return "Not found";
	if (code === "EACCES" || code === "EPERM") return "No access";
	if ((error as Error | undefined)?.message === "not an absolute path") return "Use a full path";
	return "Can't read";
}

export class MachineMonitor extends EventEmitter<{ change: [MachineSnapshot]; log: [string] }> {
	readonly #reader: MachineReader;
	readonly #intervalMs: number;
	readonly #windowMs: number;
	#timer: NodeJS.Timeout | undefined;
	#running = false;
	#busy = false;
	#paths = new Set<string>();
	#wanted = false;
	#topology: CpuTopology | undefined;
	/** Recent CPU readings, oldest first, reaching back about one window. */
	#history: { at: number; times: CpuTimes }[] = [];
	/** Last failure per source, so a lasting problem is logged once. */
	readonly #failing = new Map<string, string>();

	snapshot: MachineSnapshot | undefined;

	constructor(reader: MachineReader = systemReader, intervalMs = SAMPLE_MS, windowMs = CPU_WINDOW_MS) {
		super();
		this.#reader = reader;
		this.#intervalMs = intervalMs;
		this.#windowMs = windowMs;
	}

	/** Sample only while a Machine key is on a deck; `paths` are the disks those keys show. */
	setWanted(wanted: boolean, paths: ReadonlySet<string> = new Set()): void {
		const newPath = [...paths].some((p) => !this.#paths.has(p));
		this.#paths = new Set(paths);
		const was = this.#wanted;
		this.#wanted = wanted;
		if (!wanted) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			// Readings from before a pause would average the gap in.
			this.#history = [];
			return;
		}
		// A key just appeared, or now wants a disk not read yet: sample at once.
		if (!was || newPath) this.refresh();
	}

	start(): void {
		this.#running = true;
		if (this.#wanted) this.refresh();
	}

	stop(): void {
		this.#running = false;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	refresh(): void {
		if (!this.#running || !this.#wanted) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		void this.#tick();
	}

	async #tick(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		let delay = this.#intervalMs;
		try {
			this.snapshot = await this.#sample();
			if (this.#history.length === 1) delay = Math.min(delay, FIRST_GAP_MS);
			this.emit("change", this.snapshot);
		} catch (error) {
			this.#note("sample", error);
		} finally {
			this.#busy = false;
			if (this.#running && this.#wanted) this.#timer = setTimeout(() => void this.#tick(), delay);
		}
	}

	async #sample(): Promise<MachineSnapshot> {
		const at = Date.now();
		const load = this.#reader.load();
		const cpu = await this.#cpu(at);
		const paths = [...this.#paths];
		const [memory, ...disks] = await Promise.allSettled([this.#reader.memory(), ...paths.map((p) => this.#reader.disk(p))]);
		const out: MachineSnapshot = { at, load, cpu, disks: new Map() };
		if (memory!.status === "fulfilled") {
			out.memory = memory!.value;
			this.#failing.delete("memory");
		} else this.#note("memory", memory!.reason);
		paths.forEach((p, i) => {
			const r = disks[i]!;
			if (r.status === "fulfilled") {
				out.disks.set(p, r.value);
				this.#failing.delete(`disk ${p}`);
			} else {
				out.disks.set(p, { error: diskError(r.reason) });
				this.#note(`disk ${p}`, r.reason);
			}
		});
		return out;
	}

	/** Adds a reading and averages from the oldest one still inside the window. */
	async #cpu(at: number): Promise<CpuStats | undefined> {
		try {
			this.#topology ??= await this.#reader.topology();
			// A refresh in the same millisecond as the last reading adds nothing: keep what the key shows.
			if (this.#history.at(-1)?.at === at) return this.snapshot?.cpu;
			const times = this.#reader.cpuTimes();
			this.#history.push({ at, times });
			// The base is the newest reading at least a window old (or the oldest, while warming up).
			while (this.#history.length > 2 && this.#history[1]!.at <= at - this.#windowMs) this.#history.shift();
			const base = this.#history[0]!;
			if (base.at === at) return undefined; // the very first reading
			return cpuUsage(this.#topology, base.times, times, at - base.at) ?? this.snapshot?.cpu;
		} catch (error) {
			this.#note("cpu", error);
			return undefined;
		}
	}

	#note(source: string, error: unknown): void {
		const message = (error as Error | undefined)?.message ?? String(error);
		if (this.#failing.get(source) === message) return;
		this.#failing.set(source, message);
		this.emit("log", `machine stats: reading ${source} failed: ${message}`);
	}
}
