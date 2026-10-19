// The page's half of the verifier: it hands the archive a person drops to
// the WebAssembly build's musaiVerify, and shows what comes back. Nothing
// is sent anywhere. Everything a bundle says reaches the page as text,
// never as markup: a bundle is written by whoever sent it.

const PRINCIPAL = "anonymous";
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

const $ = (selector) => document.querySelector(selector);

let lastArchive = null;
let reportURL = null;

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The keys the person gave, as musaiVerify takes them; empty where they gave none. */
function chosenKeys() {
  const pins = $("#pins")
    .value.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const allowed = $("#allowed-signers").value;
  return {
    ...(pins.length > 0 ? { trust: pins } : {}),
    ...(allowed.trim() !== "" ? { allowedSigners: allowed } : {}),
  };
}

function show(state, summary) {
  $("#verdict").dataset.state = state;
  $("#summary").textContent = summary;
}

function clear() {
  $("#trust").textContent = "";
  $("#caution").hidden = true;
  $("#facts").hidden = true;
  $("#findings").hidden = true;
  $("#findings tbody").replaceChildren();
  $("#download").hidden = true;
  if (reportURL !== null) {
    URL.revokeObjectURL(reportURL);
    reportURL = null;
  }
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) {
    td.className = className;
  }
  return td;
}

function renderFindings(findings) {
  const rows = [...findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((finding) => {
      const row = document.createElement("tr");
      row.dataset.severity = finding.severity;
      const where = finding.at ? `${finding.path} ${finding.at}` : finding.path;
      row.append(
        cell(finding.severity, "severity"),
        cell(finding.code, "code"),
        cell(where, "mono"),
        cell(finding.detail),
      );
      return row;
    });
  $("#findings tbody").replaceChildren(...rows);
  $("#findings").hidden = rows.length === 0;
}

function render(answer, ownKeys) {
  clear();
  if (answer.error !== undefined) {
    if (answer.exitCode === 2) {
      show("refused", `Could not check it: ${answer.error}`);
    } else {
      show("broken", `The verifier itself failed: ${answer.error}`);
    }
    return;
  }
  const report = JSON.parse(answer.report);
  const findings = JSON.parse(report.observation.output);
  const count = (severity) => findings.filter((finding) => finding.severity === severity).length;
  const failed = answer.exitCode !== 0;
  const { records, signatures, trust } = answer.summary;
  show(
    failed ? "failed" : "verified",
    `${failed ? "FAILED" : "verified"}: ${plural(records, "record")}, ${plural(signatures, "signature")} verified, ` +
      `${plural(count("error"), "error")}, ${plural(count("warning"), "warning")}`,
  );
  $("#trust").textContent = ownKeys
    ? "signatures checked against the allowed-signers the bundle carries, which whoever sent it chose"
    : `signatures checked against ${trust}`;
  $("#caution").hidden = !ownKeys;

  const bundle = report.recipe.substrates.find((substrate) => substrate.name === "bundle");
  $("#digest").textContent = bundle.digest.sha256;
  $("#version").textContent = report.performer.version;
  $("#facts").hidden = false;

  renderFindings(findings);

  reportURL = URL.createObjectURL(new Blob([`${answer.report}\n`], { type: "application/json" }));
  $("#download").href = reportURL;
  $("#download").hidden = false;
}

function check(archive) {
  const keys = chosenKeys();
  const answer = globalThis.musaiVerify(archive, PRINCIPAL, keys);
  render(answer, Object.keys(keys).length === 0);
}

async function take(file) {
  show("working", `Checking ${file.name}…`);
  lastArchive = new Uint8Array(await file.arrayBuffer());
  check(lastArchive);
}

function listen() {
  const input = $("#archive");
  input.addEventListener("change", () => {
    const [file] = input.files;
    input.value = "";
    if (file) {
      take(file);
    }
  });

  const zone = $("#zone");
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("over");
    const [file] = event.dataTransfer.files;
    if (file) {
      take(file);
    }
  });

  for (const keys of [$("#allowed-signers"), $("#pins")]) {
    keys.addEventListener("change", () => {
      if (lastArchive !== null) {
        check(lastArchive);
      }
    });
  }
}

async function start() {
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(fetch("musai-verify.wasm"), go.importObject);
  go.run(instance);
  listen();
  show("idle", "Drop a bundle to check it.");
}

start().catch((error) => show("broken", `The verifier could not load: ${error}`));
