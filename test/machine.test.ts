import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSvg } from "./assets.test.ts";
import {
	coreLayout,
	cpuLevel,
	cpuTimes,
	cpuUsage,
	diskLevel,
	diskTitle,
	formatBytes,
	formatLoadShort,
	MachineMonitor,
	machineStatOf,
	memoryLevel,
	normalizeDiskPath,
	parseClusterTypes,
	parseMemory,
	parsePerfLevels,
	shortChip,
	systemReader,
	topologyFrom,
	type CpuStats,
	type CpuTimes,
	type CpuTopology,
	type MachineReader,
	type MachineSnapshot,
} from "../src/machine.ts";
import { MIN_FONT_PX, renderMachineKey } from "../src/render.ts";

const GB = 1e9;
const GIB = 2 ** 30;

test("chip names and core layouts read like Apple's", () => {
	assert.equal(shortChip("Apple M1 Max"), "M1 Max");
	assert.equal(shortChip("Apple M4"), "M4");
	assert.equal(shortChip("Apple M3 Ultra"), "M3 Ultra");
	assert.equal(shortChip("Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz"), "Core i9");
	assert.equal(shortChip(""), "CPU");
	assert.equal(coreLayout({ clusters: [{ kind: "P", cores: 8 }, { kind: "E", cores: 2 }] }), "8P+2E");
	assert.equal(coreLayout({ clusters: [{ kind: "CPU", cpus: [0, 1, 2, 3] }] }), "4 CORES");
});

const IOREG = `+-o cpu0@0  <class IOPlatformDevice>
      "logical-cluster-id" = 0
      "logical-cpu-id" = 0
      "cluster-type" = <"E">
+-o cpu1@1  <class IOPlatformDevice>
      "cluster-type" = <"E">
      "logical-cpu-id" = 1
+-o cpu2@100  <class IOPlatformDevice>
      "cluster-type" = <"P">
      "logical-cpu-id" = 2
+-o cpu3@101  <class IOPlatformDevice>
      "cluster-type" = <"P">
      "logical-cpu-id" = 3
+-o machine-timeouts  <class IOPlatformDevice>
      "cluster-type" = <"P">
`;

test("finds P and E cores from ioreg, from the kernel's counts, or not at all", () => {
	const types = parseClusterTypes(IOREG);
	assert.deepEqual([...types.entries()], [[0, "E"], [1, "E"], [2, "P"], [3, "P"]]);
	assert.deepEqual(topologyFrom("Apple M1", 4, types), { chip: "M1", clusters: [{ kind: "P", cpus: [2, 3] }, { kind: "E", cpus: [0, 1] }] });

	// No ioreg answer: the kernel's counts, E cores numbered first.
	const levels = parsePerfLevels("hw.nperflevels: 2\nhw.perflevel0.name: Performance\nhw.perflevel0.logicalcpu: 4\nhw.perflevel1.name: Efficiency\nhw.perflevel1.logicalcpu: 6\n");
	assert.deepEqual(levels, { p: 4, e: 6 });
	assert.deepEqual(topologyFrom("Apple M4", 10, new Map(), levels).clusters, [{ kind: "P", cpus: [6, 7, 8, 9] }, { kind: "E", cpus: [0, 1, 2, 3, 4, 5] }]);

	// Intel: one level, one cluster of every logical CPU.
	assert.equal(parsePerfLevels("sysctl: unknown oid 'hw.nperflevels'\n"), undefined);
	assert.deepEqual(topologyFrom("Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz", 16, new Map()), { chip: "Core i9", clusters: [{ kind: "CPU", cpus: Array.from({ length: 16 }, (_, i) => i) }] });
	// Counts that don't add up to the cores Node sees: don't guess.
	assert.equal(topologyFrom("Apple M1", 8, new Map(), { p: 4, e: 2 }).clusters.length, 1);
});

test("CPU busy share per cluster between two readings", () => {
	const topo: CpuTopology = { chip: "M1", clusters: [{ kind: "P", cpus: [2, 3] }, { kind: "E", cpus: [0, 1] }] };
	const t = (busy: number, idle: number) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
	const a = cpuTimes([t(0, 0), t(0, 0), t(0, 0), t(0, 0)]);
	const b = cpuTimes([t(900, 100), t(700, 300), t(100, 900), t(300, 700)]);
	const u = cpuUsage(topo, a, b, 30_000)!;
	assert.deepEqual(u.clusters.map((c) => [c.kind, c.cores, Math.round(c.busy)]), [["P", 2, 20], ["E", 2, 80]]);
	assert.equal(cpuUsage(topo, b, b, 0), null, "no time passed");
	assert.equal(cpuLevel(69), "ok");
	assert.equal(cpuLevel(70), "busy");
	assert.equal(cpuLevel(90), "high");
});

test("memory level follows the kernel's pressure, else the free share", () => {
	const m = (freePercent: number, pressure?: number) => ({ freePercent, pressure, totalBytes: 32 * GIB });
	assert.equal(memoryLevel(m(5, 1)), "ok"); // the kernel says normal: trust it
	assert.equal(memoryLevel(m(60, 2)), "busy");
	assert.equal(memoryLevel(m(60, 4)), "high");
	assert.equal(memoryLevel(m(30)), "ok");
	assert.equal(memoryLevel(m(20)), "busy");
	assert.equal(memoryLevel(m(8)), "high");
});

test("disk level: by share used, or by what's left", () => {
	const d = (totalGB: number, freeGB: number) => ({ totalBytes: totalGB * GB, freeBytes: freeGB * GB });
	assert.equal(diskLevel(d(494, 62)), "ok"); // 87% used, plenty left
	assert.equal(diskLevel(d(1000, 80)), "busy"); // 92%
	assert.equal(diskLevel(d(4000, 160)), "high"); // 96%, even with 160 GB left
	assert.equal(diskLevel(d(200, 20)), "busy"); // 90%… and under 25 GB
	assert.equal(diskLevel(d(100, 30)), "ok");
	assert.equal(diskLevel(d(100, 8)), "high"); // under 10 GB
});

test("formatting: decimal bytes like Finder, short load averages", () => {
	assert.equal(formatBytes(62.25 * GB), "62 GB");
	assert.equal(formatBytes(1.234e12), "1.2 TB");
	assert.equal(formatBytes(940e6), "940 MB");
	assert.equal(formatBytes(2.5 * GB), "2.5 GB");
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(999.96e9), "1.0 TB");
	assert.equal(formatLoadShort(3.24), "3.2");
	assert.equal(formatLoadShort(27.49), "27");
});

test("settings: the old 'load' stat is the CPU stat; unknown values mean summary", () => {
	assert.equal(machineStatOf("load"), "cpu");
	assert.equal(machineStatOf("cpu"), "cpu");
	assert.equal(machineStatOf("disk"), "disk");
	assert.equal(machineStatOf(undefined), "summary");
	assert.equal(machineStatOf("bogus"), "summary");
});

test("disk paths: blank is the startup disk, ~ is home; titles name the volume", () => {
	assert.equal(normalizeDiskPath(undefined), "/");
	assert.equal(normalizeDiskPath("  "), "/");
	assert.ok(normalizeDiskPath("~/Projects").endsWith("/Projects"));
	assert.ok(!normalizeDiskPath("~").includes("~"));
	assert.equal(normalizeDiskPath("/Volumes/Backup"), "/Volumes/Backup");
	assert.equal(diskTitle("/"), "DISK");
	assert.equal(diskTitle("/Volumes/Backup/"), "BACKUP");
});

test("parses sysctl's memory status and swap usage", () => {
	const m = parseMemory("76\n1\ntotal = 3072.00M  used = 2137.19M  free = 934.81M  (encrypted)\n", 32 * GIB);
	assert.equal(m.freePercent, 76);
	assert.equal(m.pressure, 1);
	assert.equal(Math.round(m.swapUsedBytes! / 2 ** 20), 2137);
	const noSwap = parseMemory("40\n2\n", 16 * GIB);
	assert.equal(noSwap.pressure, 2);
	assert.equal(noSwap.swapUsedBytes, undefined);
	assert.throws(() => parseMemory("sysctl: unknown oid\n", 0));
});

const hybrid = (p: number, e: number): CpuStats => ({ chip: "M1 Max", windowMs: 30_000, clusters: [{ kind: "P", cores: 8, busy: p }, { kind: "E", cores: 2, busy: e }] });

const snapshot = (over: Partial<MachineSnapshot> = {}): MachineSnapshot => ({
	at: 0,
	load: [47.8, 27.5, 19.5],
	cpu: hybrid(15, 36),
	memory: { freePercent: 76, pressure: 1, totalBytes: 32 * GIB, swapUsedBytes: 0 },
	disks: new Map([["/", { totalBytes: 494 * GB, freeBytes: 62 * GB }]]),
	...over,
});

function assertLegible(svg: string): void {
	assert.deepEqual(checkSvg(svg), []);
	const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
	assert.ok(sizes.length > 0 && sizes.every((s) => s >= MIN_FONT_PX), `font sizes ${sizes.join(",")}`);
}

test("summary tile: CPU follows the P cores, so a high load average with idle cores stays calm", () => {
	const svg = renderMachineKey({ stat: "summary", sample: snapshot(), path: "/" });
	assertLegible(svg);
	for (const s of [">CPU<", ">15%<", ">MEM<", ">24%<", ">DISK<", ">87%<"]) assert.ok(svg.includes(s), s);
	assert.ok(!svg.includes("#FF242F") && !svg.includes("#F5A524"), "a load average of 48 alone isn't amber or red");

	const busy = renderMachineKey({ stat: "summary", sample: snapshot({ cpu: hybrid(95, 20), memory: undefined, disks: new Map() }), path: "/Volumes/Backup" });
	assertLegible(busy);
	assert.match(busy, /fill="#FF242F"[^>]*>95%</, "P cores maxed out is red");
	assert.ok(busy.includes(">BACKUP<") && (busy.match(/>—</g) ?? []).length === 2, "unreadable rows show a dash");
	assert.match(renderMachineKey({ stat: "summary", sample: snapshot({ cpu: undefined }), path: "/" }), />…</, "CPU still measuring");
});

test("CPU tile: chip and core layout, P cores big, E cores and load underneath", () => {
	const cpu = renderMachineKey({ stat: "cpu", sample: snapshot({ cpu: hybrid(78, 100) }), path: "/" });
	assertLegible(cpu);
	for (const s of [">M1 MAX · 8P+2E<", ">78<", ">▲ P-cores busy<", ">E 100% · load 28<"]) assert.ok(cpu.includes(s), s);
	// Two bar parts, the P part four times as wide as the E part.
	const widths = [...cpu.matchAll(/<rect x="[\d.]+" y="80" width="([\d.]+)" height="10" rx="[\d.]+" fill="#5A6270"\/>/g)].map((m) => Number(m[1]));
	assert.equal(widths.length, 2);
	assert.ok(Math.abs(widths[0]! / widths[1]! - 4) < 0.01, `widths ${widths}`);

	const intel = renderMachineKey({ stat: "cpu", sample: snapshot({ cpu: { chip: "Core i9", windowMs: 30_000, clusters: [{ kind: "CPU", cores: 16, busy: 12 }] } }), path: "/" });
	assertLegible(intel);
	for (const s of [">CORE I9<", ">12<", ">● headroom<", ">16 cores · load 28<"]) assert.ok(intel.includes(s), s);
	assert.match(renderMachineKey({ stat: "cpu", sample: snapshot({ cpu: undefined }), path: "/" }), />Measuring…</);
});

test("memory and disk tiles", () => {
	const mem = renderMachineKey({ stat: "memory", sample: snapshot({ memory: { freePercent: 12, pressure: 2, totalBytes: 32 * GIB, swapUsedBytes: 2.2 * GIB } }), path: "/" });
	assertLegible(mem);
	for (const s of [">88<", ">%<", ">▲ pressure<", ">swap 2.4 GB<"]) assert.ok(mem.includes(s), s);
	assert.ok(renderMachineKey({ stat: "memory", sample: snapshot(), path: "/" }).includes(">of 34 GB<"), "no swap: total memory");

	const disk = renderMachineKey({ stat: "disk", sample: snapshot(), path: "/" });
	assertLegible(disk);
	for (const s of [">DISK<", ">87<", ">62 GB free<", ">of 494 GB<"]) assert.ok(disk.includes(s), s);

	const missing = renderMachineKey({ stat: "disk", sample: snapshot({ disks: new Map([["/Volumes/Gone", { error: "Not found" }]]) }), path: "/Volumes/Gone" });
	assert.ok(missing.includes(">GONE<") && missing.includes(">Not found<"));
	assert.ok(renderMachineKey({ stat: "cpu", sample: undefined, path: "/" }).includes(">Loading…<"));
});

class FakeReader implements MachineReader {
	loads = 0;
	topologies = 0;
	disks: string[] = [];
	memoryFails = false;
	/** Each reading adds this much busy and idle time per core. */
	busyStep = 50;
	idleStep = 50;
	#times: CpuTimes = [{ busy: 0, total: 0 }, { busy: 0, total: 0 }];
	load(): [number, number, number] {
		this.loads++;
		return [1, 1, 1];
	}
	cpuTimes(): CpuTimes {
		this.#times = this.#times.map((t) => ({ busy: t.busy + this.busyStep, total: t.total + this.busyStep + this.idleStep }));
		return this.#times;
	}
	topology = async (): Promise<CpuTopology> => {
		this.topologies++;
		return { chip: "M1", clusters: [{ kind: "P", cpus: [1] }, { kind: "E", cpus: [0] }] };
	};
	memory = async () => {
		if (this.memoryFails) throw new Error("sysctl went away");
		return { freePercent: 50, pressure: 1, totalBytes: 16 * GIB };
	};
	disk = async (path: string) => {
		this.disks.push(path);
		if (path === "/nope") throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		return { totalBytes: 100 * GB, freeBytes: 40 * GB };
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A clock the test moves, so two samples never share a millisecond by accident. Restored, and the monitor stopped, after the test. */
function fakeClock(t: { after(fn: () => void): void }, start = 1_000_000): { now: number } {
	const clock = { now: start };
	const realNow = Date.now;
	Date.now = () => clock.now;
	t.after(() => {
		Date.now = realNow;
	});
	return clock;
}

test("the monitor samples only while wanted, reads only the disks keys show, and logs a lasting failure once", async (t) => {
	const clock = fakeClock(t);
	const reader = new FakeReader();
	const monitor = new MachineMonitor(reader, 60_000);
	t.after(() => monitor.stop());
	const logs: string[] = [];
	monitor.on("log", (l) => logs.push(l));
	monitor.start();
	await settle();
	assert.equal(reader.loads, 0, "no Machine key: no sampling");

	monitor.setWanted(true, new Set(["/", "/nope"]));
	await settle();
	assert.equal(reader.loads, 1);
	assert.deepEqual(reader.disks.sort(), ["/", "/nope"]);
	assert.deepEqual(monitor.snapshot?.disks.get("/nope"), { error: "Not found" });
	assert.equal(monitor.snapshot?.memory?.freePercent, 50);
	assert.equal(monitor.snapshot?.cpu, undefined, "one reading can't give a CPU share");

	// Same paths again: no extra sample. A new path: sample at once.
	monitor.setWanted(true, new Set(["/"]));
	await settle();
	assert.equal(reader.loads, 1);
	clock.now += 5000;
	monitor.setWanted(true, new Set(["/", "/Volumes/Backup"]));
	await settle();
	assert.equal(reader.loads, 2);
	assert.equal(Math.round(monitor.snapshot!.cpu!.clusters[0]!.busy), 50);
	assert.equal(reader.topologies, 1, "the core layout is read once");

	reader.memoryFails = true;
	clock.now += 5000;
	monitor.refresh();
	await settle();
	// A refresh in the same millisecond keeps the CPU reading instead of blanking it.
	monitor.refresh();
	await settle();
	assert.equal(Math.round(monitor.snapshot!.cpu!.clusters[0]!.busy), 50);
	assert.equal(monitor.snapshot?.memory, undefined);
	assert.equal(logs.filter((l) => l.includes("memory")).length, 1, "same failure logged once");

	monitor.setWanted(false);
	const before = reader.loads;
	monitor.refresh();
	await settle();
	assert.equal(reader.loads, before, "unwanted again: refresh does nothing");
	monitor.stop();
});

test("CPU % averages over the window: old readings drop out", async (t) => {
	const reader = new FakeReader();
	let now = 1_000_000;
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const monitor = new MachineMonitor(reader, 60_000, 30_000);
		t.after(() => monitor.stop());
		monitor.start();
		monitor.setWanted(true);
		await settle();
		const step = async (ms: number, busy: number, idle: number) => {
			now += ms;
			reader.busyStep = busy;
			reader.idleStep = idle;
			monitor.refresh();
			await settle();
			return Math.round(monitor.snapshot!.cpu!.clusters[0]!.busy);
		};
		assert.equal(await step(10_000, 100, 0), 100);
		assert.equal(await step(10_000, 0, 100), 50); // 20 s window: half busy
		assert.equal(await step(10_000, 0, 100), 33);
		// 40 s in: the base moves to the reading 30 s back, so the first busy stretch drops out.
		assert.equal(await step(10_000, 0, 100), 0);
		monitor.stop();
	} finally {
		Date.now = realNow;
	}
});

test("the real reader works on this Mac", { skip: process.platform !== "darwin" }, async () => {
	const [one] = systemReader.load();
	assert.ok(Number.isFinite(one));
	const topo = await systemReader.topology();
	const cores = topo.clusters.reduce((n, c) => n + c.cpus.length, 0);
	assert.equal(cores, systemReader.cpuTimes().length);
	if (process.arch === "arm64") assert.deepEqual(topo.clusters.map((c) => c.kind), ["P", "E"]);
	const m = await systemReader.memory();
	assert.ok(m.freePercent >= 0 && m.freePercent <= 100 && m.totalBytes > 0);
	const d = await systemReader.disk("/");
	assert.ok(d.totalBytes > 0 && d.freeBytes >= 0 && d.freeBytes <= d.totalBytes);
	await assert.rejects(systemReader.disk("relative/path"));
});

test("glance style: the Usage ring's size and layout, one number in the middle", () => {
	const cpu = renderMachineKey({ stat: "cpu", sample: snapshot({ cpu: hybrid(93, 100) }), path: "/", style: "glance" });
	assertLegible(cpu);
	assert.match(cpu, /font-size="32"[^>]*fill="#FF242F"[^>]*>93</);
	assert.ok(cpu.includes(">P-CORES<") && cpu.includes(">%<"), "title on top, a small % after the number");
	// The Usage ring's size, so the keys line up on a deck.
	assert.ok(cpu.includes('stroke-width="12"') && /A45 45 /.test(cpu));
	// Two arcs of track: the P part four times as long as the E part.
	assert.equal((cpu.match(/stroke="#5A6270"/g) ?? []).length, 2);

	const mem = renderMachineKey({ stat: "memory", sample: snapshot(), path: "/", style: "glance" });
	assertLegible(mem);
	assert.ok(mem.includes(">24<") && mem.includes(">MEMORY<"));
	const disk = renderMachineKey({ stat: "disk", sample: snapshot(), path: "/Volumes/Backup", style: "glance" });
	assert.ok(disk.includes(">Loading…<"), "that disk isn't in the sample");

	const summary = renderMachineKey({ stat: "summary", sample: snapshot(), path: "/", style: "glance" });
	assertLegible(summary);
	for (const s of [">15<", ">24<", ">87<", ">CPU<", ">MEM<", ">DISK<"]) assert.ok(summary.includes(s), s);
	const sizes = [...summary.matchAll(/font-size="(\d+)"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
	assert.ok(sizes.every((n) => n >= 19), `numbers are big: ${sizes}`);
});
