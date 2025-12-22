// --- 全局变量 ---
let config = { token: '', owner: '', repo: '', path: '' };
let autoSaveTimer = null;
let isDark = false;
const API_BASE = 'https://api.github.com/repos';

// --- 初始化生命周期 ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. 优先检查外部导入 (来自扫码跳转)
    checkImport();

    // 2. 加载本地配置和主题
    loadSettings();
    initTheme();

    // 3. 根据配置状态决定下一步
    if (config.token && config.repo) {
        fetchFileList(); // 有配置，直接加载
    } else {
        openSettings();  // 无配置，弹窗提示
    }
});

// --- 关键：配置导入逻辑 (从 my-tools 接收数据) ---
function checkImport() {
    // 监听 URL Hash 格式：#import=BASE64_JSON
    const hash = window.location.hash.substring(1); // 去掉 #
    const params = new URLSearchParams(hash);
    const importData = params.get('import');

    if (importData) {
        try {
            // Base64 解码
            const configStr = atob(importData);
            const configObj = JSON.parse(configStr);

            // 简单验证
            if (!configObj.token || !configObj.repo) throw new Error("配置数据不完整");

            // 保存到 LocalStorage
            localStorage.setItem('llm_clip_config', JSON.stringify(configObj));

            // 清理 URL (深藏功与名)
            history.replaceState(null, null, window.location.pathname);

            alert("✅ 扫码登录成功！配置已同步。");
            
            // 刷新页面以应用新配置
            window.location.reload();

        } catch (e) {
            console.error("导入失败", e);
            alert("❌ 配置导入失败：数据格式错误");
        }
    }
}

// --- GitHub API 交互 ---

// 1. 获取文件列表
async function fetchFileList() {
    const select = document.getElementById('fileSelector');
    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents`;
        const res = await fetch(url, { headers: { 'Authorization': `token ${config.token}` } });
        
        if (res.status === 404) throw new Error("仓库未找到或无权限");
        const data = await res.json();
        
        // 清空并填充列表
        select.innerHTML = '';
        let foundCurrent = false;

        // 筛选 .md, .yaml, .txt
        data.forEach(file => {
            if (file.type === 'file' && /\.(md|yaml|yml|txt|json)$/i.test(file.name)) {
                const option = document.createElement('option');
                option.value = file.name;
                option.text = file.name;
                select.appendChild(option);
                if (file.name === config.path) foundCurrent = true;
            }
        });

        if (select.options.length === 0) {
            const opt = document.createElement('option');
            opt.text = "(空仓库 - 请先手动创建文件)";
            select.add(opt);
            return;
        }

        // 默认选中逻辑
        if (!foundCurrent && select.options.length > 0) {
            config.path = select.options[0].value;
            saveConfigToLocal();
        } else {
            select.value = config.path;
        }

        // 立即拉取内容
        loadContent();

    } catch (err) {
        console.error(err);
        select.innerHTML = '<option>连接失败 (检查配置)</option>';
        if(!config.token) openSettings();
    }
}

// 2. 切换文件
function changeFile() {
    const select = document.getElementById('fileSelector');
    config.path = select.value;
    saveConfigToLocal();
    loadContent();
}

// 3. 拉取内容 (GET)
async function loadContent() {
    if (!config.token || !config.path) return;
    setSaveStatus("loading", "正在拉取...");

    try {
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}?t=${Date.now()}`;
        const res = await fetch(url, { headers: { 'Authorization': `token ${config.token}` } });
        
        if (!res.ok) throw new Error(res.status);
        
        const data = await res.json();
        // 解决中文乱码
        const content = decodeUnicode(data.content);
        
        document.getElementById('editor').value = content;
        renderMarkdown(content);
        setSaveStatus("success", "已同步");

    } catch (err) {
        console.error(err);
        setSaveStatus("error", "拉取失败");
    }
}

// 4. 保存内容 (PUT)
async function pushContent() {
    if (!config.token) return;
    setSaveStatus("loading", "正在推送...");

    const content = document.getElementById('editor').value;
    renderMarkdown(content); // 同步更新预览

    try {
        // 先获取 SHA
        const url = `${API_BASE}/${config.owner}/${config.repo}/contents/${config.path}`;
        const getRes = await fetch(url, { headers: { 'Authorization': `token ${config.token}` } });
        let sha = null;
        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        // 提交更新
        const body = {
            message: `Update ${config.path} - ${new Date().toLocaleTimeString()}`,
            content: encodeUnicode(content)
        };
        if (sha) body.sha = sha;

        const putRes = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${config.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!putRes.ok) throw new Error("Save Failed");
        setSaveStatus("success", "已自动保存");

    } catch (err) {
        console.error(err);
        setSaveStatus("error", "保存失败");
    }
}

// --- 自动保存与辅助逻辑 ---

function handleInput() {
    setSaveStatus("unsaved", "输入中...");
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    // 5秒无操作后自动保存
    autoSaveTimer = setTimeout(() => {
        pushContent();
    }, 5000);
}

function manualSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    pushContent();
}

function renderMarkdown(text) {
    const preview = document.getElementById('markdown-preview');
    // 使用 Marked 解析
    preview.innerHTML = marked.parse(text || '');
    // 代码高亮
    preview.querySelectorAll('pre code').forEach((el) => hljs.highlightElement(el));
}

// 状态指示器
function setSaveStatus(state, text) {
    const el = document.getElementById('saveStatus');
    el.innerText = text;
    el.className = 'badge rounded-pill fw-normal ';
    
    if (state === 'loading') el.classList.add('text-bg-warning');
    else if (state === 'success') el.classList.add('text-bg-success');
    else if (state === 'unsaved') el.classList.add('text-bg-secondary');
    else if (state === 'error') el.classList.add('text-bg-danger');
}

// Base64 处理 (解决中文乱码)
function encodeUnicode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode('0x' + p1)));
}
function decodeUnicode(str) {
    return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}

// --- 设置与主题 ---
function loadSettings() {
    const saved = localStorage.getItem('llm_clip_config');
    if (saved) config = JSON.parse(saved);
}

function saveSettings() {
    config.token = document.getElementById('cfgToken').value.trim();
    config.owner = document.getElementById('cfgUser').value.trim();
    config.repo = document.getElementById('cfgRepo').value.trim();
    saveConfigToLocal();
    bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide();
    fetchFileList();
}

function saveConfigToLocal() {
    localStorage.setItem('llm_clip_config', JSON.stringify(config));
}

function openSettings() {
    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    document.getElementById('cfgToken').value = config.token || '';
    document.getElementById('cfgUser').value = config.owner || '';
    document.getElementById('cfgRepo').value = config.repo || '';
    modal.show();
}

function initTheme() {
    isDark = localStorage.getItem('theme') === 'dark';
    applyTheme();
}
function toggleTheme() {
    isDark = !isDark;
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    applyTheme();
}
function applyTheme() {
    document.documentElement.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
    document.getElementById('themeBtn').innerText = isDark ? '☀️' : '🌙';
}

function copyToClipboard() {
    navigator.clipboard.writeText(document.getElementById('editor').value).then(() => {
        const originalText = document.getElementById('saveStatus').innerText;
        setSaveStatus('success', '已复制!');
        setTimeout(() => setSaveStatus('success', originalText), 1500);
    });
}