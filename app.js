// --- 全局状态 ---
let config = { token: '', owner: '', repo: '', path: '' };
let currentFolder = ''; 
let currentFileSha = ''; 
let autoSaveTimer = null;
let isDark = false;
let imageCache = new Map(); 
const API_BASE = 'https://api.github.com/repos';

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    checkImport(); loadSettings(); initTheme();
    if (config.token && config.repo) { fetchFolderList().then(() => fetchFileList()); } else { openSettings(); }
    document.getElementById('editor').addEventListener('paste', handlePaste);
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 1. [新增核心] Manifest 系统逻辑 ---
async function checkManifest() {
    const banner = document.getElementById('manifestBanner');
    if (!currentFolder) { banner.style.display = 'none'; return; }

    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}/manifest.yaml?t=${Date.now()}`;
        const res = await fetch(url, { headers: { 'Authorization': `token ${config.token}` } });
        
        if (res.ok) {
            const data = await res.json();
            const content = decodeUnicode(data.content);
            
            // 简单正则解析 YAML
            const name = content.match(/skill_name:\s*(.*)/)?.[1] || "未命名技能";
            const desc = content.match(/description:\s*(.*)/)?.[1] || "识别到技能配置...";
            const ver = content.match(/version:\s*(.*)/)?.[1] || "v1.0.0";

            document.getElementById('skillName').innerText = name.replace(/['"]/g, '').trim();
            document.getElementById('skillDesc').innerText = desc.replace(/['"]/g, '').trim();
            document.getElementById('skillVersion').innerText = ver.replace(/['"]/g, '').trim();
            banner.style.display = 'block';
        } else { banner.style.display = 'none'; }
    } catch (e) { banner.style.display = 'none'; }
}

// --- 2. [新增核心] 一键 Context 聚合器 ---
async function copyFolderContext() {
    if (!currentFolder) return;
    const btn = document.getElementById('btnCopyContext');
    const originalText = btn.innerText;
    btn.innerText = "⏳ 正在拉取内容..."; btn.disabled = true;

    try {
        const listUrl = `${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}?t=${Date.now()}`;
        const res = await fetch(listUrl, { headers: { 'Authorization': `token ${config.token}` } });
        const items = await res.json();

        // 过滤支持的文本后缀
        const filesToRead = items.filter(f => f.type === 'file' && /\.(md|json|yaml|yml|txt)$/i.test(f.name));
        
        if (filesToRead.length === 0) { alert("该文件夹下无文本文件"); return; }

        // 并行拉取
        const results = await Promise.all(filesToRead.map(async (file) => {
            const fRes = await fetch(file.url, { headers: { 'Authorization': `token ${config.token}` } });
            const fData = await fRes.json();
            return { name: file.name, content: decodeUnicode(fData.content) };
        }));

        // 构造聚合文本
        let context = `【AI SKILL CONTEXT EXPORT】\nFolder: ${currentFolder}\nDate: ${new Date().toLocaleString()}\n`;
        context += `==========================================\n\n`;
        results.forEach(res => {
            context += `[FILE: ${res.name}]\n`;
            context += res.content;
            context += `\n[END OF FILE: ${res.name}]\n`;
            context += `------------------------------------------\n`;
        });
        context += `\n【EOF】`;

        await navigator.clipboard.writeText(context);
        btn.innerText = "✅ 已复制到剪贴板！";
        setTimeout(() => { btn.innerText = originalText; btn.disabled = false; }, 2000);
    } catch (e) {
        alert("聚合失败，请检查网络");
        btn.innerText = originalText; btn.disabled = false;
    }
}

// --- 搜索过滤 ---
function filterFiles() {
    const keyword = document.getElementById('fileSearchInput').value.toLowerCase();
    const items = document.querySelectorAll('#fileListGroup a');
    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(keyword) ? 'block' : 'none';
    });
}

// --- 图片上传逻辑 ---
async function handlePaste(e) {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault();
            const blob = item.getAsFile();
            await processAndUploadImage(blob);
        }
    }
}

function triggerImageUpload() { if (!config.path) { alert("请先选择文档"); return; } document.getElementById('imageFileInput').click(); }
async function handleImageFileSelect(input) { if (input.files && input.files[0]) { await processAndUploadImage(input.files[0]); input.value = ''; } }

async function processAndUploadImage(blob) {
    const editor = document.getElementById('editor');
    const start = editor.selectionStart;
    const fileName = `img_${Date.now()}.webp`;
    const filePath = `assets/images/${fileName}`;
    const placeholder = `\n![上传中...](${filePath})\n`;
    editor.value = editor.value.substring(0, start) + placeholder + editor.value.substring(editor.selectionEnd);
    setSaveStatus("loading", "正在上传图片...");
    try {
        const base64Data = await compressImage(blob);
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${filePath}`, {
            method: 'PUT', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Upload image`, content: base64Data.split(',')[1] })
        });
        if (res.ok) {
            editor.value = editor.value.replace(placeholder, `\n![${fileName}](${filePath})\n`);
            setSaveStatus("success", "图片已同步");
            renderPreview(editor.value, config.path); manualSave();
        } else { throw new Error(); }
    } catch (err) { alert("上传失败"); editor.value = editor.value.replace(placeholder, "\n[图片上传失败]\n"); }
}

function compressImage(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader(); reader.readAsDataURL(blob);
        reader.onload = (e) => {
            const img = new Image(); img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > 1200) { h = (1200 / w) * h; w = 1200; }
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/webp', 0.8));
            };
        };
    });
}

// --- 文件夹管理 ---
async function fetchFolderList() {
    const selector = document.getElementById('folderSelector');
    selector.innerHTML = '<option value="">📂 根目录 (Root)</option>';
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents?t=${Date.now()}`, { headers: { 'Authorization': `token ${config.token}` } });
        const data = await res.json();
        if (Array.isArray(data)) {
            data.filter(i => i.type === 'dir').forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.path; opt.text = `📂 ${f.name}`;
                selector.appendChild(opt);
            });
        }
        if (currentFolder) selector.value = currentFolder;
    } catch (err) {}
}

function changeFolder() {
    currentFolder = document.getElementById('folderSelector').value;
    const hasFolder = currentFolder !== "";
    document.getElementById('btnDeleteFolder').style.display = hasFolder ? 'inline-block' : 'none';
    document.getElementById('btnRenameFolder').style.display = hasFolder ? 'inline-block' : 'none';
    fetchFileList();
    checkManifest(); // 切换文件夹时检查 Manifest
}

async function createNewFolder() {
    let name = prompt("文件夹名称:"); if (!name) return;
    const path = `${name.replace(/[\/\\]/g, '').trim()}/.gitkeep`;
    setSaveStatus("loading", "同步中...");
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${path}`, {
            method: 'PUT', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Create folder`, content: btoa("") })
        });
        if (res.ok) { await sleep(1000); await fetchFolderList(); document.getElementById('folderSelector').value = name; currentFolder = name; await fetchFileList(); checkManifest(); }
    } catch (e) {} finally { setSaveStatus("success", "就绪"); }
}

async function renameCurrentFolder() {
    if (!currentFolder) return;
    const newName = prompt(`将文件夹 [${currentFolder}] 重命名为:`, currentFolder);
    if (!newName || newName === currentFolder) return;
    const cleanNewName = newName.replace(/[\/\\]/g, '').trim();
    if (!confirm(`确定重命名吗？`)) return;
    setSaveStatus("loading", "正在重命名路径...");
    try {
        const items = await (await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}?t=${Date.now()}`, { headers: { 'Authorization': `token ${config.token}` } })).json();
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const fileData = await (await fetch(item.url, { headers: { 'Authorization': `token ${config.token}` } })).json();
            await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${cleanNewName}/${item.name}`, {
                method: 'PUT', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `Rename`, content: fileData.content })
            });
            await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${item.path}`, {
                method: 'DELETE', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `Cleanup`, sha: item.sha })
            });
        }
        await sleep(1000); const oldPath = currentFolder; currentFolder = cleanNewName;
        if (config.path.startsWith(oldPath + "/")) { config.path = config.path.replace(oldPath + "/", cleanNewName + "/"); saveConfigToLocal(); }
        await fetchFolderList(); document.getElementById('folderSelector').value = cleanNewName; await fetchFileList(); checkManifest();
    } catch (e) { alert("操作失败"); } finally { setSaveStatus("success", "就绪"); }
}

async function deleteCurrentFolder() {
    if (!currentFolder || !confirm(`彻底删除文件夹 [${currentFolder}] 及其内容？`)) return;
    setSaveStatus("loading", "正在删除...");
    try {
        const items = await (await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}?t=${Date.now()}`, { headers: { 'Authorization': `token ${config.token}` } })).json();
        for (let item of items) {
            await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${item.path}`, {
                method: 'DELETE', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `Delete`, sha: item.sha })
            });
        }
        await sleep(1500); currentFolder = ''; await fetchFolderList(); await fetchFileList(); checkManifest();
    } catch (e) {} finally { setSaveStatus("success", "就绪"); }
}

// --- 文件操作 ---
async function fetchFileList() {
    const listGroup = document.getElementById('fileListGroup');
    listGroup.innerHTML = '<div class="p-4 text-center">...</div>';
    try {
        const path = currentFolder ? `/${currentFolder}` : '';
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents${path}?t=${Date.now()}`;
        const res = await fetch(url, { headers: { 'Authorization': `token ${config.token}` } });
        const data = await res.json();
        listGroup.innerHTML = '';
        if (Array.isArray(data)) {
            data.filter(f => f.type === 'file' && /\.(md|json|yaml|yml|txt)$/i.test(f.name)).forEach(file => {
                const a = document.createElement('a'); a.href = "#";
                a.setAttribute('data-path', file.path);
                a.className = `list-group-item list-group-item-action py-2 ${file.path === config.path ? 'active' : ''}`;
                let icon = '📄';
                if(file.name.endsWith('.json')) icon = '📦';
                if(file.name.endsWith('.yaml') || file.name.endsWith('.yml')) icon = '⚙️';
                if(file.name === 'manifest.yaml') icon = '💎';
                a.innerHTML = `<span class="text-truncate fw-medium">${icon} ${file.name}</span>`;
                a.onclick = (e) => { e.preventDefault(); switchFile(file.path, file.name); };
                listGroup.appendChild(a);
            });
        }
    } catch (e) { listGroup.innerHTML = '加载失败'; }
}

async function createNewFile() {
    let name = prompt("文件名 (.md, .json, .yaml):"); if (!name) return; if (!name.includes('.')) name += '.md';
    const path = currentFolder ? `${currentFolder}/${name}` : name;
    let initialContent = `# ${name}\n\n`;
    if(name.endsWith('.json')) initialContent = "{\n  \"description\": \"新建数据\",\n  \"data\": {}\n}";
    if(name.endsWith('.yaml') || name.endsWith('.yml')) initialContent = "skill_name: \"\"\ndescription: \"\"\nversion: \"1.0.0\"";
    setSaveStatus("loading", "同步中...");
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${path}`, {
            method: 'PUT', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Create`, content: encodeUnicode(initialContent) })
        });
        if (res.ok) { await sleep(1000); await fetchFileList(); switchFile(path, name); if(name==='manifest.yaml') checkManifest(); }
    } catch (e) {} finally { setSaveStatus("success", "就绪"); }
}

async function renameCurrentFile() {
    if (!config.path) return;
    const oldPath = config.path; const oldFileName = oldPath.split('/').pop();
    let newFileName = prompt(`重命名文档 [${oldFileName}] 为:`, oldFileName);
    if (!newFileName || newFileName === oldFileName) return;
    if (!newFileName.includes('.')) newFileName += '.md';
    const pathParts = oldPath.split('/'); pathParts.pop();
    const newPath = pathParts.length > 0 ? `${pathParts.join('/')}/${newFileName.trim()}` : newFileName.trim();
    setSaveStatus("loading", "正在重命名...");
    try {
        const content = document.getElementById('editor').value;
        const createRes = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${newPath}`, {
            method: 'PUT', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Rename`, content: encodeUnicode(content) })
        });
        const createData = await createRes.json();
        await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${oldPath}`, {
            method: 'DELETE', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Cleanup`, sha: currentFileSha })
        });
        config.path = newPath; currentFileSha = createData.content.sha;
        saveConfigToLocal(); await sleep(800); await fetchFileList(); switchFile(newPath, newFileName); if(newFileName==='manifest.yaml' || oldFileName==='manifest.yaml') checkManifest();
    } catch (e) { alert("失败"); } finally { setSaveStatus("success", "就绪"); }
}

async function deleteCurrentFile() {
    if (!config.path || !confirm("永久删除此文档吗？")) return;
    const isManifest = config.path.endsWith('manifest.yaml');
    setSaveStatus("loading", "正在删除...");
    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}`;
        const info = await (await fetch(url, { headers: { 'Authorization': `token ${config.token}` } })).json();
        const res = await fetch(url, {
            method: 'DELETE', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Delete`, sha: info.sha })
        });
        if (res.ok) {
            await sleep(800);
            if (currentFolder) {
                const fData = await (await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}`, { headers: { 'Authorization': `token ${config.token}` } })).json();
                if (Array.isArray(fData) && fData.length === 1 && fData[0].name === '.gitkeep') {
                    await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${fData[0].path}`, { method: 'DELETE', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Cleanup', sha: fData[0].sha }) });
                    currentFolder = ''; await fetchFolderList();
                }
            }
            config.path = ''; await fetchFileList(); switchFile('', ''); if(isManifest) checkManifest();
        }
    } catch (e) {} finally { setSaveStatus("success", "就绪"); }
}

function switchFile(path, name) {
    config.path = path; saveConfigToLocal();
    updateCurrentUI(path, name);
    if (path) loadContent(); else { document.getElementById('editor').value = ''; renderPreview('', ''); }
    const sidebar = document.getElementById('sidebarMenu');
    if (window.innerWidth < 768 && sidebar.classList.contains('show')) { bootstrap.Offcanvas.getInstance(sidebar).hide(); }
}

function updateCurrentUI(fullPath, showName) {
    if (!showName) showName = fullPath.split('/').pop();
    document.getElementById('currentFileName').innerText = showName || '未选择文件';
    document.getElementById('btnDelete').style.display = fullPath ? 'inline-block' : 'none';
    document.getElementById('btnRenameFile').style.display = fullPath ? 'inline-block' : 'none';
    const items = document.querySelectorAll('#fileListGroup a');
    items.forEach(el => {
        if (el.getAttribute('data-path') === fullPath) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } else { el.classList.remove('active'); }
    });
}

async function loadContent() {
    if (!config.path) return;
    setSaveStatus("loading", "读取中...");
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}?t=${Date.now()}`, { headers: { 'Authorization': `token ${config.token}` } });
        const data = await res.json();
        currentFileSha = data.sha;
        const content = decodeUnicode(data.content);
        document.getElementById('editor').value = content;
        renderPreview(content, config.path);
        setSaveStatus("success", "已同步");
    } catch (e) { setSaveStatus("error", "失败"); }
}

async function pushContent() {
    if (!config.path) return;
    const content = document.getElementById('editor').value;
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}`, {
            method: 'PUT', headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Update', content: encodeUnicode(content), sha: currentFileSha })
        });
        const data = await res.json();
        if (res.ok) { 
            currentFileSha = data.content.sha; setSaveStatus("success", "已保存"); 
            if(config.path.endsWith('manifest.yaml')) checkManifest();
        }
    } catch (e) { setSaveStatus("error", "失败"); }
}

function handleInput() {
    setSaveStatus("unsaved", "等待保存...");
    renderPreview(document.getElementById('editor').value, config.path);
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(pushContent, 5000);
}

// --- 渲染预览逻辑 ---
async function renderPreview(text, path) {
    const preview = document.getElementById('markdown-preview');
    if (!path || !text) { preview.innerHTML = '<p class="text-muted text-center mt-5">无内容</p>'; return; }
    const ext = path.split('.').pop().toLowerCase();

    if (ext === 'md') {
        preview.innerHTML = marked.parse(text || '');
        const imgs = preview.querySelectorAll('img');
        for (let img of imgs) {
            const src = img.getAttribute('src');
            if (src && src.includes('assets/images') && !src.startsWith('http')) {
                if (imageCache.has(src)) { img.src = imageCache.get(src); } else {
                    try {
                        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${src}`, { headers: { 'Authorization': `token ${config.token}` } });
                        const data = await res.json();
                        const blob = await (await fetch(`data:image/webp;base64,${data.content}`)).blob();
                        const objUrl = URL.createObjectURL(blob); imageCache.set(src, objUrl); img.src = objUrl;
                    } catch (e) {}
                }
            }
        }
    } else if (ext === 'json') {
        let formatted = text; try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
        preview.innerHTML = `<pre><code class="language-json">${formatted}</code></pre>`;
    } else if (ext === 'yaml' || ext === 'yml') {
        preview.innerHTML = `<pre><code class="language-yaml">${text}</code></pre>`;
    } else {
        preview.innerHTML = `<pre><code class="language-plaintext">${text}</code></pre>`;
    }
    preview.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
}

// --- 基础工具 ---
function encodeUnicode(s) { return btoa(encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode('0x' + p1))); }
function decodeUnicode(s) { return decodeURIComponent(atob(s).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')); }
function setSaveStatus(s, t) { const el = document.getElementById('saveStatus'); el.innerText = t; el.className = 'badge rounded-pill fw-normal small ' + (s==='loading'?'text-bg-warning':s==='success'?'text-bg-success':s==='error'?'text-bg-danger':'text-bg-secondary'); }
function manualSave() { clearTimeout(autoSaveTimer); pushContent(); }
function loadSettings() { const s = localStorage.getItem('llm_clip_config'); if(s) config = JSON.parse(s); }
function saveConfigToLocal() { localStorage.setItem('llm_clip_config', JSON.stringify(config)); }
function saveSettings() {
    config.token = document.getElementById('cfgToken').value.trim();
    config.owner = document.getElementById('cfgUser').value.trim();
    config.repo = document.getElementById('cfgRepo').value.trim();
    saveConfigToLocal(); location.reload();
}
function openSettings() { 
    new bootstrap.Modal(document.getElementById('settingsModal')).show();
    document.getElementById('cfgToken').value = config.token;
    document.getElementById('cfgUser').value = config.owner;
    document.getElementById('cfgRepo').value = config.repo;
}
function toggleTheme() { isDark = !isDark; localStorage.setItem('theme', isDark?'dark':'light'); applyTheme(); }
function applyTheme() { document.documentElement.setAttribute('data-bs-theme', isDark?'dark':'light'); document.getElementById('themeBtn').innerText = isDark?'☀️':'🌙'; }
function initTheme() { isDark = localStorage.getItem('theme')==='dark'; applyTheme(); }
function checkImport() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const data = params.get('import');
    if (data) { localStorage.setItem('llm_clip_config', atob(data)); history.replaceState(null,null,window.location.pathname); location.reload(); }
}
function copyToClipboard() { navigator.clipboard.writeText(document.getElementById('editor').value).then(()=>alert("已复制")); }