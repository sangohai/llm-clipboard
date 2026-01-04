// --- 全局变量 ---
let config = { token: '', owner: '', repo: '', path: '' };
let currentFolder = ''; 
let currentFileSha = ''; 
let autoSaveTimer = null;
let isDark = false;
let imageCache = new Map(); // 私有图片缓存
const API_BASE = 'https://api.github.com/repos';

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    checkImport();
    loadSettings();
    initTheme();

    if (config.token && config.repo) {
        fetchFolderList().then(() => fetchFileList());
    } else {
        openSettings();
    }

    // 绑定粘贴事件
    document.getElementById('editor').addEventListener('paste', handlePaste);
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 搜索功能 ---
function filterFiles() {
    const keyword = document.getElementById('fileSearchInput').value.toLowerCase();
    const items = document.querySelectorAll('#fileListGroup a');
    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(keyword) ? 'block' : 'none';
    });
}

// --- 图片上传与压缩逻辑 ---
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

function triggerImageUpload() {
    if (!config.path) { alert("请先选择或新建一个文档"); return; }
    document.getElementById('imageFileInput').click();
}

async function handleImageFileSelect(input) {
    if (input.files && input.files[0]) {
        await processAndUploadImage(input.files[0]);
        input.value = ''; // 重置清空
    }
}

async function processAndUploadImage(blob) {
    const editor = document.getElementById('editor');
    const start = editor.selectionStart;
    const fileName = `img_${Date.now()}.webp`;
    const filePath = `assets/images/${fileName}`;
    const placeholder = `\n![正在上传图片...](${filePath})\n`;

    // 插入占位符
    editor.value = editor.value.substring(0, start) + placeholder + editor.value.substring(editor.selectionEnd);
    setSaveStatus("loading", "正在压缩并上传...");

    try {
        const base64Data = await compressImage(blob);
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${filePath}`;
        
        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `Upload image ${fileName}`,
                content: base64Data.split(',')[1]
            })
        });

        if (res.ok) {
            editor.value = editor.value.replace(placeholder, `\n![${fileName}](${filePath})\n`);
            setSaveStatus("success", "图片上传成功");
            renderMarkdown(editor.value);
            manualSave();
        } else { throw new Error(); }
    } catch (err) {
        alert("图片上传失败");
        editor.value = editor.value.replace(placeholder, "\n[图片上传失败]\n");
    }
}

function compressImage(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                const MAX_WIDTH = 1200;
                if (w > MAX_WIDTH) { h = (MAX_WIDTH / w) * h; w = MAX_WIDTH; }
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/webp', 0.8));
            };
        };
    });
}

// --- 文件夹管理 ---
async function fetchFolderList() {
    const selector = document.getElementById('folderSelector');
    selector.innerHTML = '<option value="">📂 根目录</option>';
    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents?t=${Date.now()}`;
        const res = await fetch(url, { headers: { 'Authorization': `token ${config.token}` } });
        const data = await res.json();
        if (Array.isArray(data)) {
            data.filter(i => i.type === 'dir').forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.path; opt.text = `📂 ${f.name}`;
                selector.appendChild(opt);
            });
        }
        if (currentFolder) selector.value = currentFolder;
    } catch (err) { console.error(err); }
}

function changeFolder() {
    currentFolder = document.getElementById('folderSelector').value;
    const hasFolder = currentFolder !== "";
    document.getElementById('btnDeleteFolder').style.display = hasFolder ? 'inline-block' : 'none';
    document.getElementById('btnRenameFolder').style.display = hasFolder ? 'inline-block' : 'none';
    fetchFileList();
}

async function createNewFolder() {
    let name = prompt("请输入新文件夹名称:");
    if (!name) return;
    name = name.replace(/[\/\\]/g, '').trim();
    const path = `${name}/.gitkeep`;
    setSaveStatus("loading", "创建中...");
    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${path}`;
        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Create folder ${name}`, content: btoa("") })
        });
        if (res.ok) {
            await sleep(1000); await fetchFolderList();
            document.getElementById('folderSelector').value = name;
            currentFolder = name; await fetchFileList();
        }
    } catch (e) { alert("创建失败"); }
    finally { setSaveStatus("success", "就绪"); }
}

async function renameCurrentFolder() {
    if (!currentFolder) return;
    const newName = prompt(`重命名 [${currentFolder}] 为:`, currentFolder);
    if (!newName || newName === currentFolder) return;
    const cleanNewName = newName.replace(/[\/\\]/g, '').trim();

    if (!confirm(`确定要重命名文件夹吗？内部文件将批量移动。`)) return;
    setSaveStatus("loading", "正在重命名路径...");

    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}?t=${Date.now()}`;
        const items = await (await fetch(url, { headers: { 'Authorization': `token ${config.token}` } })).json();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            setSaveStatus("loading", `搬迁中 (${i + 1}/${items.length})`);
            const fileData = await (await fetch(item.url, { headers: { 'Authorization': `token ${config.token}` } })).json();
            
            // PUT 新路径
            await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${cleanNewName}/${item.name}`, {
                method: 'PUT',
                headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `Rename move`, content: fileData.content })
            });
            // DELETE 旧路径
            await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${item.path}`, {
                method: 'DELETE',
                headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `Rename cleanup`, sha: item.sha })
            });
        }
        await sleep(1000);
        const oldPath = currentFolder;
        currentFolder = cleanNewName;
        if (config.path.startsWith(oldPath + "/")) {
            config.path = config.path.replace(oldPath + "/", cleanNewName + "/");
            saveConfigToLocal();
        }
        await fetchFolderList();
        document.getElementById('folderSelector').value = cleanNewName;
        await fetchFileList();
    } catch (e) { alert("操作失败"); }
    finally { setSaveStatus("success", "就绪"); }
}

async function deleteCurrentFolder() {
    if (!currentFolder || !confirm(`确定彻底删除文件夹 [${currentFolder}] 吗？`)) return;
    setSaveStatus("loading", "清理中...");
    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}?t=${Date.now()}`;
        const items = await (await fetch(url, { headers: { 'Authorization': `token ${config.token}` } })).json();
        for (let item of items) {
            await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${item.path}`, {
                method: 'DELETE',
                headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `Delete bulk`, sha: item.sha })
            });
        }
        await sleep(1500); currentFolder = ''; await fetchFolderList(); await fetchFileList();
    } catch (e) { alert("删除失败"); }
    finally { setSaveStatus("success", "就绪"); }
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
            data.filter(f => f.type === 'file' && /\.(md|txt|json)$/i.test(f.name)).forEach(file => {
                const a = document.createElement('a');
                a.className = `list-group-item list-group-item-action py-2 ${file.path === config.path ? 'active' : ''}`;
                a.innerHTML = `<span class="text-truncate fw-medium">${file.name}</span>`;
                a.onclick = () => switchFile(file.path, file.name);
                listGroup.appendChild(a);
            });
        }
    } catch (e) { listGroup.innerHTML = '加载失败'; }
}

async function createNewFile() {
    let name = prompt("文档名称:");
    if (!name) return; if (!name.includes('.')) name += '.md';
    const path = currentFolder ? `${currentFolder}/${name}` : name;
    setSaveStatus("loading", "同步中...");
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${path}`, {
            method: 'PUT',
            headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Create ${path}`, content: encodeUnicode(`# ${name}\n`) })
        });
        if (res.ok) { await sleep(1000); await fetchFileList(); switchFile(path, name); }
    } catch (e) { alert("失败"); }
    finally { setSaveStatus("success", "就绪"); }
}

async function deleteCurrentFile() {
    if (!config.path || !confirm("确定要永久删除此文档吗？")) return;
    setSaveStatus("loading", "正在删除...");
    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}`;
        const info = await (await fetch(url, { headers: { 'Authorization': `token ${config.token}` } })).json();
        const res = await fetch(url, {
            method: 'DELETE',
            headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Delete ${config.path}`, sha: info.sha })
        });
        if (res.ok) {
            await sleep(800);
            if (currentFolder) {
                const fData = await (await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${currentFolder}`, { headers: { 'Authorization': `token ${config.token}` } })).json();
                if (Array.isArray(fData) && fData.length === 1 && fData[0].name === '.gitkeep') {
                    await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${fData[0].path}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: 'Auto cleanup', sha: fData[0].sha })
                    });
                    currentFolder = ''; await fetchFolderList();
                }
            }
            config.path = ''; await fetchFileList(); switchFile('', '');
        }
    } catch (e) { alert("操作失败"); }
    finally { setSaveStatus("success", "就绪"); }
}

function switchFile(path, name) {
    config.path = path; saveConfigToLocal();
    document.getElementById('currentFileName').innerText = name || path.split('/').pop() || '未选择文件';
    document.getElementById('btnDelete').style.display = path ? 'inline-block' : 'none';
    if (path) loadContent(); else { document.getElementById('editor').value = ''; renderMarkdown(''); }
}

async function loadContent() {
    if (!config.path) return;
    setSaveStatus("loading", "读取中...");
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}?t=${Date.now()}`, {
            headers: { 'Authorization': `token ${config.token}` }
        });
        const data = await res.json();
        currentFileSha = data.sha;
        const content = decodeUnicode(data.content);
        document.getElementById('editor').value = content;
        renderMarkdown(content);
        setSaveStatus("success", "已同步");
    } catch (e) { setSaveStatus("error", "同步失败"); }
}

async function pushContent() {
    if (!config.path) return;
    const content = document.getElementById('editor').value;
    try {
        const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}`, {
            method: 'PUT',
            headers: { 'Authorization': `token ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Update', content: encodeUnicode(content), sha: currentFileSha })
        });
        const data = await res.json();
        if (res.ok) { currentFileSha = data.content.sha; setSaveStatus("success", "已保存"); }
    } catch (e) { setSaveStatus("error", "保存失败"); }
}

function handleInput() {
    setSaveStatus("unsaved", "等待保存...");
    renderMarkdown(document.getElementById('editor').value);
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(pushContent, 5000);
}

// --- 增强渲染 (私有图片支持) ---
async function renderMarkdown(text) {
    const preview = document.getElementById('markdown-preview');
    preview.innerHTML = marked.parse(text || '');
    preview.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));

    const imgs = preview.querySelectorAll('img');
    for (let img of imgs) {
        const src = img.getAttribute('src');
        if (src && src.includes('assets/images') && !src.startsWith('http')) {
            if (imageCache.has(src)) {
                img.src = imageCache.get(src);
            } else {
                try {
                    const res = await fetch(`${API_BASE}/${config.owner}/${config.repo}/contents/${src}`, {
                        headers: { 'Authorization': `token ${config.token}` }
                    });
                    const data = await res.json();
                    const blob = await (await fetch(`data:image/webp;base64,${data.content}`)).blob();
                    const objUrl = URL.createObjectURL(blob);
                    imageCache.set(src, objUrl);
                    img.src = objUrl;
                } catch (e) { console.error("图片加载失败", src); }
            }
        }
    }
}

// --- 基础工具 ---
function encodeUnicode(s) { return btoa(encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode('0x' + p1))); }
function decodeUnicode(s) { return decodeURIComponent(atob(s).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')); }
function setSaveStatus(s, t) {
    const el = document.getElementById('saveStatus'); el.innerText = t;
    el.className = 'badge rounded-pill fw-normal small ' + (s==='loading'?'text-bg-warning':s==='success'?'text-bg-success':s==='error'?'text-bg-danger':'text-bg-secondary');
}
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
function applyTheme() { 
    document.documentElement.setAttribute('data-bs-theme', isDark?'dark':'light');
    document.getElementById('themeBtn').innerText = isDark?'☀️':'🌙';
}
function initTheme() { isDark = localStorage.getItem('theme')==='dark'; applyTheme(); }
function checkImport() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const data = params.get('import');
    if (data) {
        localStorage.setItem('llm_clip_config', atob(data));
        history.replaceState(null,null,window.location.pathname);
        location.reload();
    }
}
function copyToClipboard() { navigator.clipboard.writeText(document.getElementById('editor').value).then(()=>alert("已复制全文到剪贴板")); }