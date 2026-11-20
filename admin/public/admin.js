const $ = (id) => document.getElementById(id);
let csrf = "";
let currentFile = "";
let currentSha = "";
let originalContent = "";
let fileCache = {};
let selectedImage = null;

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function showApp() {
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
}
function showLogin() {
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
}
function setDirty() {
  const dirty = $("codeEditor").value !== originalContent;
  $("dirtyState").textContent = dirty ? "● Unsaved changes" : "✓ All changes saved";
  $("saveBtn").disabled = !currentFile || !dirty;
}
function escapeText(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
function renderFiles(files) {
  const list = $("fileList");
  list.innerHTML = "";
  const groups = [
    ["PAGES", files.filter(x => x.path.endsWith(".html"))],
    ["STYLES & SCRIPTS", files.filter(x => x.path.endsWith(".css") || x.path.endsWith(".js"))],
    ["SITE SETTINGS", files.filter(x => !x.path.endsWith(".html") && !x.path.endsWith(".css") && !x.path.endsWith(".js"))]
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const heading = document.createElement("div");
    heading.className = "file-list-title";
    heading.textContent = label;
    list.appendChild(heading);
    for (const item of items) {
      const button = document.createElement("button");
      button.className = "file-item" + (item.path === currentFile ? " active" : "");
      button.innerHTML = '<span class="file-icon">' + (item.path.endsWith(".html") ? "◇" : item.path.endsWith(".css") ? "✳" : item.path.endsWith(".js") ? "⌘" : "▤") + '</span><span>' + escapeText(item.path) + '</span>';
      button.addEventListener("click", () => loadFile(item.path));
      list.appendChild(button);
    }
  }
}
async function loadFiles() {
  const result = await api("/api/files");
  renderFiles(result.files);
}
async function loadFile(file) {
  if ($("codeEditor").value !== originalContent && !confirm("Discard your unsaved edits and open another file?")) return;
  $("fileStatus").textContent = "Loading…";
  try {
    const data = await api("/api/file?path=" + encodeURIComponent(file));
    currentFile = data.path;
    currentSha = data.sha;
    originalContent = data.content;
    fileCache[file] = data.content;
    $("activeFile").textContent = file;
    $("fileStatus").textContent = "Loaded from GitHub · " + BRANCH_LABEL;
    $("codeEditor").disabled = false;
    $("codeEditor").value = data.content;
    renderFiles((await api("/api/files")).files);
    setDirty();
  } catch (error) {
    $("fileStatus").textContent = error.message;
  }
}
const BRANCH_LABEL = "main";
$("codeEditor").addEventListener("input", setDirty);

$("saveBtn").addEventListener("click", async () => {
  if (!currentFile) return;
  const button = $("saveBtn");
  if (!confirm("This will create a commit on main and publish the changes to your live website. Have you checked the preview?")) return;
  button.disabled = true;
  button.textContent = "Publishing…";
  try {
    const result = await api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path: currentFile, content: $("codeEditor").value, sha: currentSha, message: "Edit " + currentFile + " from website control center" })
    });
    currentSha = result.sha;
    originalContent = $("codeEditor").value;
    fileCache[currentFile] = originalContent;
    $("fileStatus").textContent = "Saved · Commit " + String(result.commit || "").slice(0, 7);
    setDirty();
  } catch (error) {
    $("fileStatus").textContent = error.message;
    $("saveBtn").disabled = false;
  } finally {
    button.textContent = "Save changes ↑";
  }
});

document.querySelectorAll(".side-tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".side-tab").forEach(item => item.classList.toggle("active", item === button));
    ["editor", "images", "preview"].forEach(name => $(name + "Panel").classList.toggle("hidden", button.dataset.panel !== name));
    if (button.dataset.panel === "preview") refreshPreview();
  });
});

$("imageInput").addEventListener("change", () => {
  selectedImage = $("imageInput").files[0] || null;
  $("uploadBtn").disabled = !selectedImage;
  $("uploadStatus").textContent = selectedImage ? selectedImage.name + " · " + (selectedImage.size / 1024 / 1024).toFixed(2) + " MB" : "";
});
$("uploadBtn").addEventListener("click", async () => {
  if (!selectedImage) return;
  if (selectedImage.size > 5 * 1024 * 1024) return $("uploadStatus").textContent = "Image is larger than 5 MB.";
  const button = $("uploadBtn");
  button.disabled = true;
  button.textContent = "Uploading…";
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(selectedImage);
    });
    const result = await api("/api/upload", {
      method: "POST",
      body: JSON.stringify({ path: $("imageTarget").value, mime: selectedImage.type, base64 })
    });
    $("uploadStatus").textContent = "Image replaced successfully. Commit " + String(result.commit || "").slice(0, 7) + ". GitHub Pages will publish it shortly.";
    $("imageInput").value = "";
    selectedImage = null;
  } catch (error) {
    $("uploadStatus").textContent = error.message;
  } finally {
    button.textContent = "Replace selected image";
    button.disabled = !selectedImage;
  }
});

async function refreshPreview() {
  const page = $("previewPage").value;
  try {
    const htmlData = page === currentFile
      ? { content: $("codeEditor").value }
      : { content: fileCache[page] || (await api("/api/file?path=" + encodeURIComponent(page))).content };
    fileCache[page] = htmlData.content;
    let css = fileCache["styles.css"];
    if (css === undefined) css = (await api("/api/file?path=styles.css")).content;
    fileCache["styles.css"] = css;
    if (currentFile === "styles.css") css = $("codeEditor").value;
    let html = htmlData.content;
    html = html.replace(/<link[^>]+href=["']styles\.css["'][^>]*>/i, "");
    html = html.replace(/<script[^>]+src=["']script\.js["'][^>]*><\/script>/i, "");
    const base = '<base href="' + "https://nasif-spica-rollins-ug.github.io/" + '">';
    const style = "<style>" + css.replace(/<\/style/gi, "<\\/style") + "</style>";
    html = html.replace(/<head([^>]*)>/i, "<head$1>" + base + style);
    $("previewFrame").srcdoc = html;
  } catch (error) {
    $("previewFrame").srcdoc = "<p style='font:14px sans-serif;color:#b44;padding:24px'>Preview unavailable: " + escapeText(error.message) + "</p>";
  }
}
$("refreshPreview").addEventListener("click", refreshPreview);
$("previewPage").addEventListener("change", refreshPreview);

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("loginError").textContent = "";
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("password").value, code: $("code").value })
    });
    csrf = result.csrf;
    $("password").value = "";
    $("code").value = "";
    showApp();
    await loadFiles();
    await loadFile("index.html");
  } catch (error) {
    $("loginError").textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
});
$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
  csrf = "";
  currentFile = "";
  showLogin();
});

(async function init() {
  try {
    const result = await api("/api/me");
    csrf = result.csrf;
    showApp();
    await loadFiles();
    await loadFile("index.html");
  } catch {
    showLogin();
  }
})();