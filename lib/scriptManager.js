const fs = require("node:fs");
const path = require("node:path");
const { SCRIPTS_DIR, ensureScriptsDir } = require("./ensureDirs");

const MAX_NAME_LENGTH = 120;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeName(value) {
  let name = String(value || "").trim();
  if (!name) throw httpError("Script name is required", 400);
  if (!name.toLowerCase().endsWith(".sql")) name += ".sql";
  if (name.length > MAX_NAME_LENGTH) {
    throw httpError(`Script name is too long (max ${MAX_NAME_LENGTH})`, 400);
  }
  // Keep files portable and prevent traversal outside data/scripts.
  if (name === "." || name === ".." || /[/\\\0-\x1f<>:"|?*]/.test(name)) {
    throw httpError("Script name contains invalid characters", 400);
  }
  return name;
}

function sqlFileNames() {
  ensureScriptsDir();
  return fs
    .readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"),
    )
    .map((entry) => entry.name);
}

function findExistingName(value) {
  const requested = normalizeName(value);
  return (
    sqlFileNames().find(
      (name) => name.toLowerCase() === requested.toLowerCase(),
    ) || null
  );
}

function scriptPath(name) {
  return path.join(SCRIPTS_DIR, normalizeName(name));
}

function mapScript(name) {
  const filePath = scriptPath(name);
  const stat = fs.statSync(filePath);
  return {
    id: name,
    name,
    sql_text: fs.readFileSync(filePath, "utf8"),
    created_at: stat.birthtime.toISOString(),
    updated_at: stat.mtime.toISOString(),
  };
}

function atomicWrite(name, sql) {
  ensureScriptsDir();
  const target = scriptPath(name);
  const temp = path.join(
    SCRIPTS_DIR,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, String(sql ?? ""), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function listScripts() {
  return sqlFileNames()
    .map(mapScript)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function getScript(id) {
  const name = findExistingName(id);
  return name ? mapScript(name) : null;
}

function createScript({ name, sql_text = "" } = {}) {
  const nextName = normalizeName(name);
  if (findExistingName(nextName)) {
    throw httpError(`A script named "${nextName}" already exists`, 409);
  }
  atomicWrite(nextName, sql_text);
  return mapScript(nextName);
}

function updateScript(id, { name, sql_text } = {}) {
  const currentName = findExistingName(id);
  if (!currentName) throw httpError("Script not found", 404);

  const nextName = name === undefined ? currentName : normalizeName(name);
  const clash = findExistingName(nextName);
  if (clash && clash.toLowerCase() !== currentName.toLowerCase()) {
    throw httpError(`A script named "${nextName}" already exists`, 409);
  }

  const currentPath = scriptPath(currentName);
  const nextSql =
    sql_text === undefined
      ? fs.readFileSync(currentPath, "utf8")
      : String(sql_text ?? "");

  atomicWrite(nextName, nextSql);
  if (nextName !== currentName && fs.existsSync(currentPath)) {
    fs.unlinkSync(currentPath);
  }
  return mapScript(nextName);
}

function deleteScript(id) {
  const name = findExistingName(id);
  if (!name) throw httpError("Script not found", 404);
  fs.unlinkSync(scriptPath(name));
  return { ok: true };
}

module.exports = {
  SCRIPTS_DIR,
  ensureScriptsDir,
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
};
