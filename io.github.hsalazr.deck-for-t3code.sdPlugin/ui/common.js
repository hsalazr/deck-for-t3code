// Minimal property-inspector bridge (no external dependencies).
// Stream Deck calls connectElgatoStreamDeckSocket when the inspector opens.
const PI = {
  socket: null, uuid: null, action: null, settings: {}, global: {},
  onSettings: () => {}, onGlobal: () => {},
  /** Handlers for sendToPropertyInspector messages, by `type`. */
  handlers: {},
  /** Runs once the socket is open. */
  ready: [],
  send(event, payload) {
    if (!this.socket || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify({ event, context: this.uuid, action: this.action, payload }));
  },
  setSettings(patch) { this.settings = { ...this.settings, ...patch }; this.send("setSettings", this.settings); },
  setGlobal(patch) { this.global = { ...this.global, ...patch }; this.send("setGlobalSettings", this.global); },
  toPlugin(payload) { this.send("sendToPlugin", payload); },
  on(type, fn) { (this.handlers[type] ??= []).push(fn); },
  whenReady(fn) { if (this.socket?.readyState === 1) fn(); else this.ready.push(fn); },
};

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
  const info = JSON.parse(actionInfo);
  PI.uuid = uuid;
  PI.action = info.action;
  PI.settings = info.payload?.settings ?? {};
  PI.socket = new WebSocket(`ws://127.0.0.1:${port}`);
  PI.socket.onopen = () => {
    PI.socket.send(JSON.stringify({ event: registerEvent, uuid }));
    PI.send("getGlobalSettings");
    PI.onSettings(PI.settings);
    for (const fn of PI.ready.splice(0)) fn();
  };
  PI.socket.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.event === "didReceiveGlobalSettings") { PI.global = data.payload.settings ?? {}; PI.onGlobal(PI.global); }
    else if (data.event === "didReceiveSettings") { PI.settings = data.payload.settings ?? {}; PI.onSettings(PI.settings); }
    else if (data.event === "sendToPropertyInspector") for (const fn of PI.handlers[data.payload?.type] ?? []) fn(data.payload);
  };
};

const DEFAULT_MESSAGES = ["continue", "summarize where you are", "run the tests and report", "explain the last change", "what's left to do?", "write a handoff note"];
const DEFAULTS = { pollSeconds: 2, recentHours: 8, showSnoozed: false, flashOnDone: true, flashOnFailed: true, animation: "smooth", showLabels: false, t3Home: "",
  actionsEnabled: false, messages: DEFAULT_MESSAGES.join("\n") };

// ---------- Connection status (top of every inspector) ----------

const REASONS = {
  "not-installed": "T3 Code isn't installed",
  "not-running": "Open T3 Code",
  "cli-missing": "T3 CLI missing",
  "sign-in-failed": "Sign-in failed — see logs",
  "signed-out": "Signed out — use Sign in below",
  "server-error": "T3 Code error — see logs",
};

/**
 * Wording for a `{type:"signedOut"}` reply: `ok` means the plugin signed out,
 * `failed` counts tokens T3 Code hasn't revoked yet (they are retried later).
 */
function signOutText(msg) {
  if (!msg.ok) return { text: "Sign-out failed — see logs", tone: "bad" };
  if (msg.failed > 0) return { text: `Signed out — ${msg.failed} token${msg.failed === 1 ? "" : "s"} will be revoked later`, tone: "ok" };
  return { text: "Signed out", tone: "ok" };
}

/** Human wording for a `{type:"status"}` reply. `connection` may be a kind string or a Connection object. */
function statusText(msg) {
  const kind = typeof msg.connection === "string" ? msg.connection : msg.connection?.kind;
  const reason = msg.reason ?? msg.connection?.reason;
  if (kind === "ok") return { text: "Connected", tone: "ok" };
  if (msg.signedOut) return { text: "Signed out — use Sign in below", tone: "" };
  if (kind === "connecting") return { text: "Connecting to T3 Code…", tone: "" };
  if (reason && REASONS[reason]) return { text: REASONS[reason], tone: "bad" };
  return { text: kind === "error" ? "T3 Code error — see logs" : "T3 Code isn't reachable", tone: "bad" };
}

/** Status row; asks the plugin every 3 s while the inspector is open. */
function mountStatus() {
  const row = document.createElement("div");
  row.className = "status-row";
  row.innerHTML = `<span class="dot"></span><span class="text">Checking T3 Code…</span>`;
  document.body.prepend(row);
  const textEl = row.querySelector(".text");
  let answered = false;
  PI.on("status", (msg) => {
    answered = true;
    const { text, tone } = statusText(msg);
    row.className = `status-row ${tone}`;
    textEl.textContent = text;
    row.title = msg.detail || msg.connection?.detail || "";
  });
  const ask = () => PI.toPlugin({ type: "status" });
  PI.whenReady(() => {
    ask();
    setInterval(ask, 3000);
    setTimeout(() => { if (!answered) textEl.textContent = "No answer from the plugin yet"; }, 7000);
  });
}

// ---------- Global settings ----------

const GLOBALS_HTML = `
  <h3>Thread actions</h3>
  <div class="row"><label>Actions</label><div class="check"><input type="checkbox" data-global="actionsEnabled" id="ae"><label for="ae">Enable thread actions</label></div></div>
  <div class="hint">Lets the Thread Actions page stop, snooze and settle threads, and send messages to your agents. Off: those keys stay dimmed and nothing is sent.</div>
  <h3>All keys</h3>
  <div class="row"><label>Show idle for</label><select data-global="recentHours"><option value="0">Active threads only</option><option value="1">1 hour</option><option value="4">4 hours</option><option value="8">8 hours</option><option value="24">1 day</option><option value="72">3 days</option></select></div>
  <div class="row" style="align-items:start"><label>Highlight when</label><div>
    <div class="note">An agent needs input: always (blinks amber)</div>
    <div class="check"><input type="checkbox" data-global="flashOnDone" id="d"><label for="d">A run finishes (solid green, no blink)</label></div>
    <div class="check"><input type="checkbox" data-global="flashOnFailed" id="f"><label for="f">A run fails (blinks red)</label></div>
  </div></div>
  <div class="row"><label>Status label</label><div class="check"><input type="checkbox" data-global="showLabels" id="sl"><label for="sl">Show WORKING / DONE / … above the title</label></div></div>
  <div class="row"><label>Animation</label><select data-global="animation"><option value="smooth">Blink and spin</option><option value="off">Off (steady colors)</option></select></div>
  <div class="row"><label>Snoozed</label><div class="check"><input type="checkbox" data-global="showSnoozed" id="s"><label for="s">Show snoozed threads</label></div></div>
  <div class="row"><label>Refresh every</label><select data-global="pollSeconds"><option value="2">2 s</option><option value="5">5 s</option><option value="10">10 s</option></select></div>
  <div class="row"><label>T3 home</label><input type="text" data-global="t3Home" placeholder="~/.t3 (default)"></div>
  <h3>Sign-in</h3>
  <div class="row"><label>Tokens</label><div><button type="button" id="signOut">Sign out / revoke tokens</button> <span class="result" id="signOutResult"></span></div></div>
  <div class="hint">Revokes the tokens this plugin minted with the T3 CLI (listed in <code>t3 auth session list</code>) and deletes them from this Mac.</div>`;

/** Puts the shared settings into `#globals` (if the page has one) and wires them up. */
function mountGlobals() {
  const host = document.getElementById("globals");
  if (host) host.innerHTML = GLOBALS_HTML;
  bindGlobals();
  bindSignOut();
}

// Wires every [data-global] input to a global setting.
function bindGlobals() {
  const inputs = document.querySelectorAll("[data-global]");
  const fill = (g) => {
    for (const el of inputs) {
      const key = el.dataset.global;
      const value = g[key] ?? DEFAULTS[key];
      if (el.type === "checkbox") el.checked = !!value;
      else if (document.activeElement !== el) el.value = value ?? "";
    }
  };
  // Inputs stay disabled until the real globals arrive, so a change can't overwrite them with defaults.
  for (const el of inputs) el.disabled = true;
  PI.onGlobal = (g) => { fill(g); for (const el of inputs) el.disabled = false; };
  fill(DEFAULTS);
  for (const el of inputs) {
    const save = () => {
      const key = el.dataset.global;
      let value = el.type === "checkbox" ? el.checked : el.value;
      if (el.type === "number" || key === "pollSeconds" || key === "recentHours") value = Number(value);
      PI.setGlobal({ [key]: value });
    };
    el.addEventListener("change", save);
    // Text areas save while you type (debounced), so closing the inspector never loses an edit.
    if (el.tagName === "TEXTAREA") {
      let timer;
      el.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(save, 400); });
    }
  }
}

function bindSignOut() {
  const button = document.getElementById("signOut");
  const result = document.getElementById("signOutResult");
  if (!button) return;
  const OUT = "Sign out / revoke tokens";
  const IN = "Sign in again";
  let signedOut = false;
  let armedUntil = 0;
  const label = () => { if (!button.disabled) button.textContent = signedOut ? IN : OUT; };
  // The status row tells us whether we're signed out (e.g. after a sign-out from another key).
  PI.on("status", (msg) => { signedOut = !!msg.signedOut; if (Date.now() > armedUntil) label(); });
  button.addEventListener("click", () => {
    result.textContent = "";
    if (signedOut) {
      button.disabled = true;
      button.textContent = "Signing in…";
      PI.toPlugin({ type: "signIn" });
      return;
    }
    // Two clicks: the first only asks to confirm.
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + 4000;
      button.textContent = "Click again to sign out";
      setTimeout(() => { if (Date.now() >= armedUntil) label(); }, 4100);
      return;
    }
    armedUntil = 0;
    button.disabled = true;
    button.textContent = "Signing out…";
    PI.toPlugin({ type: "signOut" });
  });
  PI.on("signedOut", (msg) => {
    button.disabled = false;
    if (msg.ok) signedOut = true;
    label();
    const { text, tone } = signOutText(msg);
    result.className = `result ${tone}`;
    result.textContent = text;
  });
  PI.on("signedIn", (msg) => {
    button.disabled = false;
    if (msg.ok) signedOut = false;
    label();
    result.className = `result ${msg.ok ? "ok" : "bad"}`;
    result.textContent = msg.ok ? "Signed in" : "Sign-in failed — see logs";
  });
}
