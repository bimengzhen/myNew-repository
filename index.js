import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced, addOneMessage, saveChatDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const MODULE_NAME = 'minimax_quote_tts';
const PROXY_ENDPOINT = '/api/minimax/generate-voice';
const DEFAULT_API_HOST = 'https://api.minimax.chat';
const API_HOST_OPTIONS = [
    { value: 'https://api.minimax.chat',   label: '国内源 (api.minimax.chat)' },
    { value: 'https://api.minimax.io',     label: '国际源 (api.minimax.io)' },
    { value: 'https://api.minimaxi.chat',  label: '备用源 (api.minimaxi.chat)' },
];

const TARGET_TYPE = { CURRENT_CHARACTER: 'current_character', CURRENT_USER: 'current_user', CUSTOM: 'custom' };
const API_FORMATS = { OAI: 'openai', GOOGLE: 'google' };


const MODEL_OPTIONS = [
    { value: 'speech-02-hd',    label: 'speech-02-hd (高清)' },
    { value: 'speech-02-turbo', label: 'speech-02-turbo (极速)' },
    { value: 'speech-01-hd',    label: 'speech-01-hd (高清旧版)' },
    { value: 'speech-01-turbo', label: 'speech-01-turbo (极速旧版)' },
    { value: 'speech-01',       label: 'speech-01 (标准)' },
];

const defaults = {
    enabled: true, autoPlay: true, showMessageButton: true, onlyCharacter: true,
    apiKey: '', groupId: '', apiHost: DEFAULT_API_HOST, model: 'speech-02-hd', voiceId: 'male-qn-qingse',
    speed: 1, vol: 1, pitch: 0, emotion: '', audioFormat: 'mp3', ttsLanguage: '',
    maxQuotesPerMessage: 4, minLength: 1, maxLength: 300, ignoreCodeBlocks: true,
    characterBindingsMap: {}, llmPresets: [], formatterTemplates: [],
    formatterEnabled: false, formatterPresetIdx: -1,
    formatterSystemPrompt: '请以严格的 JSON 格式返回：{"segments":[{"text":"...","speaker":"...","emotion":"...","speed":1.0,"vol":1.0,"pitch":0}]}. 仅保留可朗读的内容。',
    serverHistory: {},
    voiceLibrary: [],
    regexRules: [],
    regexPresets: [],
    vcPromptBlocks: null,
    vcPromptTemplates: [],
    llmPreProcessRules: [],
    showBubbles: false,
    vrmEnabled: false,
    vrmModelUrl: '',
    vrmFilename: '',
    vrmBg: 'transparent',
    vrmLlmPresetIdx: -1,
    vrmPixelRatio: 1,
};

let playbackQueue = [], isPlaying = false, clickTimer = null;
let activeAudio = new Audio();
const localAudioCache = new Map();

function s() { return extension_settings[MODULE_NAME]; }

function escHtml(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function parsePattern(str) {
    const s = (str || '').trim();
    if (s.startsWith('/')) {
        const last = s.lastIndexOf('/');
        if (last > 0) return s.slice(1, last);
    }
    return s;
}

async function loadAllWbEntries() {
    const ctx = getContext();
    const worldMap = new Map();

    // 1. 角色绑定
    try {
        const charWorld = ctx.characters?.[ctx.characterId]?.data?.extensions?.world;
        if (charWorld) worldMap.set(charWorld, '📌 角色绑定');
    } catch (_) {}

    // 2. 聊天绑定
    try {
        const chatWorld = ctx.chatMetadata?.world_info;
        if (chatWorld && !worldMap.has(chatWorld)) worldMap.set(chatWorld, '💬 聊天绑定');
    } catch (_) {}

    // 3. 全局启用
    try {
        const selWorlds = ctx.selected_world_info || ctx.selectedWorldInfo || [];
        if (Array.isArray(selWorlds)) {
            for (const n of selWorlds) {
                if (n && !worldMap.has(n)) worldMap.set(n, '🌐 全局启用');
            }
        }
    } catch (_) {}

    // 4. 从 world-info.js 模块获取全部世界书名
    try {
        const wiModule = await import('../../../world-info.js');
        const wn = wiModule.world_names;
        if (Array.isArray(wn)) {
            for (const n of wn) {
                if (n && typeof n === 'string' && !worldMap.has(n)) {
                    worldMap.set(n, '📚 可用');
                }
            }
        }
    } catch (e) {
        console.warn('[MiniMax] world-info.js 导入失败:', e.message);
    }

    // 5. DOM 兜底：从界面下拉框抓取
    if (worldMap.size === 0) {
        try {
            const selectors = [
                '#world_info select option',
                '#world_editor_select option',
                'select[name*="world"] option',
                '.world_info_selector option',
            ];
            for (const sel of selectors) {
                document.querySelectorAll(sel).forEach(opt => {
                    const n = (opt.value || opt.textContent || '').trim();
                    if (n && n !== '' && n.toLowerCase() !== 'none' && !worldMap.has(n)) {
                        worldMap.set(n, '📚 可用');
                    }
                });
            }
        } catch (_) {}
    }

    // 6. API 兜底
    if (worldMap.size === 0) {
        try {
            const res = await fetch('/api/worldinfo/settings', {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (res.ok) {
                const data = await res.json();
                const names = data.world_names || data.worldNames || [];
                for (const n of names) {
                    if (n && !worldMap.has(n)) worldMap.set(n, '📚 可用');
                }
            }
        } catch (_) {}
    }

    if (worldMap.size === 0) {
        console.warn('[MiniMax] 未找到任何世界书');
        return [];
    }

    console.log('[MiniMax] 发现世界书:', [...worldMap.keys()]);

    // 逐个加载条目
    const allEntries = [];
    for (const [worldName, source] of worldMap) {
        try {
            let data = null;
            if (typeof ctx.loadWorldInfo === 'function') {
                data = await ctx.loadWorldInfo(worldName);
            }
            if (!data || !data.entries) {
                try {
                    const res = await fetch('/api/worldinfo/get', {
                        method: 'POST',
                        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: worldName }),
                    });
                    if (res.ok) data = await res.json();
                } catch (_) {}
            }
            if (!data || !data.entries) continue;

            for (const entry of Object.values(data.entries)) {
                const keys = [];
                if (Array.isArray(entry.key)) keys.push(...entry.key);
                else if (typeof entry.key === 'string' && entry.key) keys.push(...entry.key.split(',').map(k => k.trim()).filter(Boolean));
                if (Array.isArray(entry.keysecondary)) keys.push(...entry.keysecondary);

                allEntries.push({
                    key: worldName + '::' + entry.uid,
                    title: entry.comment || ('条目 ' + entry.uid),
                    content: entry.content || '',
                    worldName: worldName,
                    source: source,
                    uid: entry.uid,
                    disabled: !!entry.disable,
                    keys: keys,
                });
            }
        } catch (e) {
            console.warn('[MiniMax] 加载世界书 "' + worldName + '" 失败:', e.message);
        }
    }
    return allEntries;
}


function applyPreProcessRules(text) {
    const rules = (s().llmPreProcessRules || []).filter(r => r.enabled && r.pattern);
    if (!rules.length) return text;
    for (const rule of rules) {
        let re;
        try { re = new RegExp(parsePattern(rule.pattern), 'gs'); } catch(e) { continue; }
        if (rule.mode === 'extract') {
            const matches = [];
            let m;
            while ((m = re.exec(text)) !== null) {
                const t = (m[1] !== undefined ? m[1] : m[0]).trim();
                if (t) matches.push(t);
            }
            if (matches.length) text = matches.join('\n');
        } else {
            text = text.replace(re, '');
        }
    }
    return text.trim();
}

function getBuiltinQuoteRule() {
    return {
        id: 'builtin-quotes', enabled: true, name: '引号内容',
        pattern: '[\\u0022\\u201c\\u300c\\u300e\\u2018]([^\\u0022\\u201c\\u201d\\u300c\\u300d\\u300e\\u300f\\u2018\\u2019]{1,500}?)[\\u0022\\u201d\\u300d\\u300f\\u2019]',
        flags: 'g', mode: 'extract',
    };
}

function loadSettings() {
    if (extension_settings[MODULE_NAME]?._loaded) return; // 
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const settings = extension_settings[MODULE_NAME];
    for (const key in defaults) { if (settings[key] === undefined) settings[key] = JSON.parse(JSON.stringify(defaults[key])); }
    if (settings.formatterPresets?.length > 0 && settings.llmPresets.length === 0) {
        settings.llmPresets = settings.formatterPresets.map(p => ({ name: p.name, url: p.url || '', key: p.key || '', format: p.format || API_FORMATS.OAI, model: p.model || '' }));
    }
    if (!settings.llmPresets.length && (settings.formatterApiUrl || settings.vcLlmApiUrl)) {
        const url = settings.formatterApiUrl || settings.vcLlmApiUrl || '';
        const key = settings.formatterApiKey || settings.vcLlmApiKey || '';
        const model = settings.formatterModel || settings.vcLlmModel || '';
        if (url || model) {
            settings.llmPresets.push({ name: '迁移预设', url, key, format: settings.formatterFormat || API_FORMATS.OAI, model });
            settings.formatterPresetIdx = 0;
        }
    }
    if (!Array.isArray(settings.regexRules) || settings.regexRules.length === 0) {
        settings.regexRules = [getBuiltinQuoteRule()];
        if (settings.customRegexPattern && settings.regexMode === 'custom') {
            settings.regexRules.push({
                id: 'migrated-' + Date.now(), enabled: true, name: '迁移正则',
                pattern: settings.customRegexPattern, flags: settings.customRegexFlags || 'g', mode: 'extract',
            });
        }
    }
    if (Array.isArray(settings.vcPromptBlocks) && !settings.vcPromptBlocks.some(b => b.id === 'worldBook')) {
        const worldBookBlock = { id: 'worldBook', enabled: false, label: '世界书', editable: false, hint: '（世界书注入内容）' };
        const afterIdx = settings.vcPromptBlocks.findIndex(b => b.id === 'charDesc');
        if (afterIdx >= 0) settings.vcPromptBlocks.splice(afterIdx + 1, 0, worldBookBlock);
        else settings.vcPromptBlocks.unshift(worldBookBlock);
    }
    if (Array.isArray(settings.vcPromptBlocks) && !settings.vcPromptBlocks.some(b => b.id === 'vrmActions')) {
        const vrmActionsBlock = { id: 'vrmActions', enabled: false, label: 'VRM表情/动作', editable: false, hint: '（视频通话时让 AI 输出表情动作标签，语音通话无效）' };
        settings.vcPromptBlocks.push(vrmActionsBlock);
    }
    delete settings.quoteOnly;
    delete settings.regexMode;
    delete settings.customRegexPattern;
    delete settings.customRegexFlags;
    settings._loaded = true;
}

function simpleHash(t) {
    if (!t) return 0;
    let h = 0; for (let i = 0; i < t.length; i++) h = ((h << 5) - h) + t.charCodeAt(i), h |= 0;
    return Math.abs(h);
}

function buildMessageKey(ctx, id, m) {
    return `${ctx.chatId || 'no-chat'}:${id}:${m?.swipe_id || 0}:${simpleHash(m?.mes)}`;
}

function getMessageData(id) {
    const ctx = getContext(); const m = ctx?.chat?.[id];
    return { ctx, message: m, key: m ? buildMessageKey(ctx, id, m) : '' };
}

function normalizeOaiUrl(url) {
    let u = (url || '').trim().replace(/\/+$/, ''); if (!u) return '';
    if (!u.endsWith('/chat/completions')) u += '/chat/completions';
    return u;
}

// --- ST Server Sync ---
async function uploadToSTServer(blob, filename) {
    try {
        const reader = new FileReader();
        const base64 = await new Promise(r => { reader.onloadend = () => r(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
        const res = await fetch('/api/files/upload', {
            method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `minimax_${filename}`, data: base64 })
        });
        const data = await res.json(); return data.path;
    } catch (e) { return null; }
}

async function getAudioFromSTServer(path) {
    try { const res = await fetch(path, { headers: getRequestHeaders() }); return res.ok ? await res.blob() : null; } catch (e) { return null; }
}

async function syncToSTSecrets(apiKey, groupId) {
    try {
        const writes = [];
        if (apiKey)  writes.push(fetch('/api/secrets/write', { method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'api_key_minimax',   value: apiKey  }) }));
        if (groupId) writes.push(fetch('/api/secrets/write', { method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'minimax_group_id', value: groupId }) }));
        await Promise.all(writes);
    } catch (e) {
        console.warn('[MiniMax] secrets 同步失败:', e.message);
    }
}

async function proxyFetch(url, options = {}) {
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: options.body != null ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) throw new Error(data?.error?.message || data?.error || (typeof data === 'string' ? data : `HTTP ${res.status}`));
    return data;
}

// ★ 修复4: 直连 MiniMax API fallback（当 ST 代理端点不可用时）
async function directMinimaxTts(text, options) {
    const set = s();
    const apiKey = (set.apiKey || '').trim();
    const groupId = (set.groupId || '').trim();
    if (!apiKey) throw new Error('请先填写 MiniMax API Key');

    const apiHost = (set.apiHost || DEFAULT_API_HOST).replace(/\/+$/, '');
    const url = `${apiHost}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;

    const body = {
        model: options.model || set.model,
        text: text,
        stream: false,
        voice_setting: {
            voice_id: options.voiceId || set.voiceId,
            speed: Number(options.speed ?? set.speed),
            vol: Number(options.vol ?? set.vol),
            pitch: Number(options.pitch ?? set.pitch),
        },
        audio_setting: {
            sample_rate: 32000,
            format: options.audioFormat || 'mp3',
        },
    };
    if (options.emotion) body.voice_setting.emotion = options.emotion;
    if (options.language) body.voice_setting.language_boost = options.language;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const e = await res.json(); msg = e.base_resp?.status_msg || e.error?.message || msg; } catch (_) {}
        throw new Error(msg);
    }

    const data = await res.json();
    if (data.base_resp?.status_code !== 0 && data.base_resp?.status_code !== undefined) {
        throw new Error(data.base_resp?.status_msg || 'MiniMax API 返回错误');
    }

    const audioData = data.data?.audio || data.audio;
    if (!audioData) throw new Error('API 返回无音频数据');

    // base64 → Blob
    const byteChars = atob(audioData);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', flac: 'audio/flac' };
    return new Blob([byteArray], { type: mimeMap[options.audioFormat] || 'audio/mpeg' });
}

// ★ 修复4: getAudioBlob 增加 fallback
async function getAudioBlob(item) {
    const cacheKey = `tts_${simpleHash(item.text)}_${simpleHash(JSON.stringify(item.options))}`;
    if (localAudioCache.has(cacheKey)) return localAudioCache.get(cacheKey);
    if (item.serverPath) {
        const res = await fetch(item.serverPath, { headers: getRequestHeaders() });
        if (res.ok) { const b = await res.blob(); localAudioCache.set(cacheKey, b); return b; }
    }
    const set = s();

    let blob;
    // 先尝试 ST 代理端点
    try {
        const res = await fetch(PROXY_ENDPOINT, {
            method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: item.text, apiHost: set.apiHost, model: item.options.model, voiceId: item.options.voiceId,
                speed: item.options.speed, volume: item.options.vol, pitch: item.options.pitch,
                format: item.options.audioFormat, emotion: item.options.emotion,
                language: item.options.language || undefined,
            }),
        });
        if (!res.ok) {
            // 404 或 501 说明端点不存在/不支持，走直连
            if (res.status === 404 || res.status === 501 || res.status === 405) {
                throw new Error('PROXY_NOT_AVAILABLE');
            }
            let msg = `HTTP ${res.status}`;
            try { const e = await res.json(); msg = e.error || e.message || msg; } catch (_) {}
            throw new Error(msg);
        }
        blob = await res.blob();
    } catch (proxyErr) {
        console.warn('[MiniMax] 代理端点失败，尝试直连:', proxyErr.message);
        // fallback: 直连 MiniMax API
        blob = await directMinimaxTts(item.text, item.options);
    }

    localAudioCache.set(cacheKey, blob);
    uploadToSTServer(blob, `${cacheKey}.${item.options.audioFormat}`).then(path => {
        if (path) { item.serverPath = path; saveSettingsDebounced(); }
    });
    return blob;
}

// --- Player ---
async function playNext() {
    if (playbackQueue.length === 0) { isPlaying = false; return; }
    isPlaying = true; const item = playbackQueue.shift();
    if (item.pauseMs) { await new Promise(r => setTimeout(r, item.pauseMs)); playNext(); return; }
    try {
        const blob = await getAudioBlob(item);
        const url = URL.createObjectURL(blob);
        activeAudio.src = url;
        activeAudio.onended = () => { URL.revokeObjectURL(url); playNext(); };
        activeAudio.onerror = () => { URL.revokeObjectURL(url); playNext(); };
        await activeAudio.play();
    } catch (e) { console.error('[MiniMax TTS] playNext error:', e); playNext(); }
}

async function formatWithSecondaryApi(m) {
    const set = s();
    const preset = (set.llmPresets || [])[set.formatterPresetIdx];
    if (!preset) throw new Error('请先在「LLM 预设管理」中选择一个预设');
    const format = preset.format || API_FORMATS.OAI, prompt = set.formatterSystemPrompt;
    try {
        let text;
        if (format === API_FORMATS.OAI) {
            const url = normalizeOaiUrl(preset.url);
            const data = await proxyFetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...(preset.key ? { 'Authorization': `Bearer ${preset.key.trim()}` } : {}) },
                body: { model: preset.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: applyPreProcessRules(m.mes) }], temperature: 0.1 }
            });
            text = data.choices?.[0]?.message?.content;
        } else {
            const baseUrl = (preset.url || '').trim().replace(/\/+$/, '');
            const gUrl = `${baseUrl}/v1beta/models/${preset.model}:generateContent`;
            const gHeaders = { 'Content-Type': 'application/json', ...(preset.key ? { 'x-goog-api-key': preset.key.trim() } : {}) };
            const data = await proxyFetch(gUrl, { method: 'POST', headers: gHeaders, body: { contents: [{ role: 'user', parts: [{ text: `System Prompt: ${prompt}\n\nUser Message: ${applyPreProcessRules(m.mes)}` }] }] } });
            text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        }
        const match = text.match(/\{[\s\S]*\}/); if (!match) throw new Error('AI 无有效 JSON');
        return JSON.parse(match[0])?.segments || null;
    } catch (e) { throw e; }
}

function findCharacterBinding(speakerName) {
    if (!speakerName) return null;
    const set = s(), ctx = getContext(), name = speakerName.toLowerCase();
    const id = ctx.characterId || ctx.character_id || ctx.name2 || 'global';
    const bindings = set.characterBindingsMap[id] || [];
    return bindings.find(b => {
        const bName = (b.targetType === TARGET_TYPE.CUSTOM ? b.customName : (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 : ctx.name1))?.toLowerCase();
        return bName === name;
    });
}

function buildSynthesisOptions(seg, m) {
    const set = s(); const b = findCharacterBinding(seg?.speaker || m?.name);
    return {
        model: seg?.model || b?.model || set.model, voiceId: seg?.voiceId || b?.voiceId || set.voiceId,
        speed: Number(seg?.speed || set.speed), vol: Number(set.vol || 1.0), pitch: Number(set.pitch || 0),
        emotion: seg?.emotion || set.emotion || undefined, audioFormat: set.audioFormat || 'mp3',
        language: set.ttsLanguage || undefined,
    };
}

async function generateMessageSpeech(id, forced = false) {
    const { message, key } = getMessageData(id); if (!message || (s().onlyCharacter && message.is_user)) return false;
    let h = s().serverHistory[key]; if (!forced && h?.versions?.length) return true;
    try {
        let raw;
        if (s().formatterEnabled) {
            raw = await formatWithSecondaryApi(message);
        } else {
            const cleanText = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
            const rules = (s().regexRules || []).filter(r => r.enabled);
            if (!rules.length) {
                raw = [];
            } else {
                let extracted = [];
                for (const rule of rules.filter(r => r.mode === 'extract')) {
                    let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
                    let qm;
                    while ((qm = re.exec(cleanText)) !== null) {
                        const t = (qm[1]?.replace(/\n+/g, ' ').trim()) || (qm[0]?.replace(/\n+/g, ' ').trim());
                        if (t) extracted.push({ text: t, speaker: message.name });
                    }
                }
                for (const rule of rules.filter(r => r.mode === 'exclude')) {
                    let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
                    extracted = extracted.filter(seg => !re.test(seg.text));
                }
                raw = extracted;
            }
        }
        const items = raw.map(seg => ({ text: seg.text, speaker: seg.speaker || message.name, options: buildSynthesisOptions(seg, message), serverPath: null }));
        if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
        s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
        s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
        saveSettingsDebounced(); refreshAllMessageButtons(); injectBubbles(id); return true;
    } catch (e) { toastr.error('生成失败: ' + e.message); return false; }
}

function extractSegmentsOnly(id) {
    if (!s().showBubbles) return false;
    const { message, key } = getMessageData(id);
    if (!message || message.is_system || (s().onlyCharacter && message.is_user)) return false;
    if (s().serverHistory[key]?.versions?.length) return true;
    if (message?.extra?.voice_call) return false;
    if (/class="/.test(message.mes)) return false;
    if (s().formatterEnabled) return false;
    const cleanText = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
    const rules = (s().regexRules || []).filter(r => r.enabled);
    if (!rules.length) return false;
    let extracted = [];
    for (const rule of rules.filter(r => r.mode === 'extract')) {
        let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
        let qm;
        while ((qm = re.exec(cleanText)) !== null) {
            const t = (qm[1]?.replace(/\n+/g, ' ').trim()) || (qm[0]?.replace(/\n+/g, ' ').trim());
            if (t) extracted.push({ text: t, speaker: message.name });
        }
    }
    for (const rule of rules.filter(r => r.mode === 'exclude')) {
        let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
        extracted = extracted.filter(seg => !re.test(seg.text));
    }
    if (!extracted.length) return false;
    const items = extracted.map(seg => ({ text: seg.text, speaker: seg.speaker || message.name, options: buildSynthesisOptions(seg, message), serverPath: null }));
    if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
    s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
    s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
    saveSettingsDebounced();
    return true;
}

async function playGeneratedMessage(id) {
    const { key } = getMessageData(id); const h = s().serverHistory[key];
    if (!h?.versions[h.activeIndex]) return false;
    playbackQueue = [...h.versions[h.activeIndex].items];
    activeAudio.pause(); activeAudio.src = '';
    if (!isPlaying) playNext();
    setTimeout(() => saveSettingsDebounced(), 2000);
    return true;
}

function isBubbleCached(item) {
    if (!item || item.pauseMs) return false;
    if (item.serverPath) return true;
    const cacheKey = `tts_${simpleHash(item.text)}_${simpleHash(JSON.stringify(item.options))}`;
    return localAudioCache.has(cacheKey);
}

function refreshBubbleStates(mesid) {
    const { key } = getMessageData(mesid);
    const h = s().serverHistory[key];
    const items = h?.versions?.[h.activeIndex]?.items || [];
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesid}"]`);
    if (!mesEl) return;
    mesEl.querySelectorAll('.mm-bubble').forEach(bubble => {
        const item = items[Number(bubble.dataset.segidx)];
        if (item) bubble.classList.toggle('mm-bubble-cached', isBubbleCached(item));
    });
}

function refreshAllMessageButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const id = el.getAttribute('mesid'), { message, key } = getMessageData(id);
        if (!message || message.is_system || /class="/.test(message.mes || '')) return;
        const extra = el.querySelector('.extraMesButtons'); if (!extra) return;
        let btn = el.querySelector('.mes_quote_tts');
        if (!btn) { btn = document.createElement('div'); btn.className = 'mes_button mes_quote_tts fa-solid fa-volume-high'; extra.appendChild(btn); }
        const h = s().serverHistory[key];
        let ready;
        if (s().showBubbles && h?.versions?.[h.activeIndex]?.items?.length > 0) {
            ready = h.versions[h.activeIndex].items.filter(it => !it.pauseMs && it.text).every(isBubbleCached);
        } else {
            ready = !!(h?.versions?.length > 0);
        }
        btn.classList.toggle('ready', ready);
    });
}

function makeBubble(mesid, segidx, item, withText = false) {
    const el = document.createElement('span');
    el.className = 'mm-bubble';
    el.dataset.mesid = mesid;
    el.dataset.segidx = segidx;
    el.title = item.text;
    el.innerHTML = withText
        ? `<i class="fa-solid fa-volume-low"></i>${escHtml(item.text.length > 20 ? item.text.slice(0, 20) + '…' : item.text)}`
        : `<i class="fa-solid fa-volume-low"></i>`;
    if (isBubbleCached(item)) el.classList.add('mm-bubble-cached');
    return el;
}

function injectAfterText(container, searchText, insertEl) {
    if (!searchText) return false;
    const filter = {
        acceptNode: n => n.parentElement.closest('.mm-bubble, .mm-bubble-strip')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    };
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, filter);
    let node;
    while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(searchText);
        if (idx < 0) continue;
        const endIdx = idx + searchText.length;
        const after = node.textContent.slice(endIdx);
        node.textContent = node.textContent.slice(0, endIdx);
        const parent = node.parentNode, next = node.nextSibling;
        parent.insertBefore(insertEl, next);
        if (after) parent.insertBefore(document.createTextNode(after), insertEl.nextSibling);
        return true;
    }
    return false;
}

function injectAfterClosingQuote(container, innerText, insertEl) {
    if (!innerText) return false;
    const CLOSE_QUOTES = ['"', '\u201d', '\u300d', '\u300f', '\u2019', "'"];
    for (const closeQ of CLOSE_QUOTES) {
        const target = innerText + closeQ;
        if (injectAfterText(container, target, insertEl)) return true;
    }
    return false;
}

function injectBubbles(mesid) {
    if (!s().showBubbles) return;
    if (document.getElementById('minimax_quote_tts_editor')) return;
    const { message, key } = getMessageData(mesid);
    if (!message || message.is_system) return;
    if (!message.extra?.voice_call && /class="/.test(message.mes || '')) return;
    const h = s().serverHistory[key];
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesid}"]`);
    if (!mesEl) return;
    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return;

    const allItems = h?.versions?.[h.activeIndex]?.items || [];
    const items = allItems.map((it, idx) => ({ it, idx })).filter(({ it }) => !it.pauseMs && it.text);

    const ver = `${key}:${h?.activeIndex}:${items.length}`;
    const actualBubbles = textEl.querySelectorAll('.mm-bubble').length;
    if (textEl.dataset.mmBubVer === ver && actualBubbles === items.length) {
        refreshBubbleStates(mesid);
        return;
    }

    // 清除旧气泡
    textEl.querySelectorAll('.mm-bubble').forEach(el => el.remove());
    textEl.querySelector('.mm-bubble-strip')?.remove();
    if (!items.length) { delete textEl.dataset.mmBubVer; return; }

    // 判断是否为「引号提取」模式
    const isQuoteMode = !s().formatterEnabled && (s().regexRules || []).some(
        r => r.enabled && r.mode === 'extract'
    );

    const unmatched = [];

    items.forEach(({ it: item, idx }) => {
        const bubble = makeBubble(mesid, idx, item, false);

        if (isQuoteMode) {
            // 引号模式：只在「文本+闭合引号」处注入
            if (!injectAfterClosingQuote(textEl, item.text, bubble)) {
                unmatched.push({ item, idx });
            }
        } else {
            // LLM 格式化模式：按原逻辑找裸文本
            if (!injectAfterText(textEl, item.text, bubble)) {
                unmatched.push({ item, idx });
            }
        }
    });

    // 引号模式下不显示底部条（旁白不出气泡）
    // LLM 模式下才显示底部条
    if (unmatched.length && !isQuoteMode) {
        const strip = document.createElement('div');
        strip.className = 'mm-bubble-strip';
        unmatched.forEach(({ item, idx }) => strip.appendChild(makeBubble(mesid, idx, item, true)));
        textEl.appendChild(strip);
    }

    textEl.dataset.mmBubVer = ver;
}

function refreshAllBubbles() {
    if (!s().showBubbles) return;
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const id = Number(el.getAttribute('mesid'));
        extractSegmentsOnly(id);
        injectBubbles(id);
    });
}

function removeAllBubbles() {
    document.querySelectorAll('.mm-bubble, .mm-bubble-strip').forEach(el => el.remove());
    document.querySelectorAll('[data-mm-bub-ver]').forEach(el => el.removeAttribute('data-mm-bub-ver'));
}

function openParamsEditor(id) {
    const { key } = getMessageData(id); let h = s().serverHistory[key]; if (!h?.versions?.length) return;
    const render = () => {
        const v = h.versions[h.activeIndex];
        const rows = v.items.map((it, i) => `
            <div class="minimax-tts-editor-item">
                <div style="font-size:0.8rem; opacity:0.6; margin-bottom:4px;">说话人: <input class="edit-v" data-prop="speaker" data-idx="${i}" value="${it.speaker || ''}" style="width:100px; height:20px !important; display:inline-block; border:none !important; background:none !important; color:inherit !important; padding:0 !important;"></div>
                <textarea class="text_pole" readonly style="width:100%; height:40px; margin-bottom:8px; background:rgba(0,0,0,0.2) !important;">${it.text}</textarea>
                <div class="minimax-tts-editor-grid">
                    <div class="minimax-tts-editor-row-flex"><label>模型</label><select class="text_pole edit-v" data-prop="model" data-idx="${i}">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
                    <div class="minimax-tts-editor-row-flex"><label>语音</label><input class="text_pole edit-v" data-prop="voiceId" data-idx="${i}" value="${it.options.voiceId}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>情感</label><input class="text_pole edit-v" data-prop="emotion" data-idx="${i}" value="${it.options.emotion||''}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>语速</label><input class="text_pole edit-v" data-prop="speed" type="number" step="0.1" data-idx="${i}" value="${it.options.speed}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音量</label><input class="text_pole edit-v" data-prop="vol" type="number" step="0.1" data-idx="${i}" value="${it.options.vol}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音调</label><input class="text_pole edit-v" data-prop="pitch" type="number" step="1" data-idx="${i}" value="${it.options.pitch}"></div>
                </div>
            </div>`).join('');
        const html = `<div id="minimax_quote_tts_editor" class="minimax-tts-editor-mask"><div class="minimax-tts-editor-dialog">
            <div class="minimax-tts-editor-header">
                <div style="font-weight:bold; font-size:1.1rem; flex:1">版本历史 ${h.activeIndex+1}/${h.versions.length}</div>
                <div style="display:flex; gap:10px; align-items:center; justify-content:center; flex:1">
                    <button class="menu_button v-prev" style="width:40px;"> < </button>
                    <button class="menu_button v-next" style="width:40px;"> > </button>
                    <button class="menu_button v-del" style="color:#ef5350;" title="删除此版本">删除</button>
                </div>
                <div style="text-align:right;"><button class="menu_button editor-close">关闭面板</button></div>
            </div>
            <div class="minimax-tts-editor-body">${rows}</div>
            <div class="minimax-tts-editor-actions">
                <button class="menu_button editor-save-only" style="height:40px;">保存修改</button>
                <button class="menu_button editor-confirm" style="height:40px;">确认并选择此版本</button>
            </div>
        </div></div>`;
        $('#minimax_quote_tts_editor').remove(); $('body').append(html);
        $('#minimax_quote_tts_editor .v-prev').on('click', () => { if(h.activeIndex>0){ h.activeIndex--; render(); } });
        $('#minimax_quote_tts_editor .v-next').on('click', () => { if(h.activeIndex<h.versions.length-1){ h.activeIndex++; render(); } });
        $('#minimax_quote_tts_editor .v-del').on('click', () => {
            if (h.versions.length <= 1) {
                delete s().serverHistory[key];
                saveSettingsDebounced(); refreshAllMessageButtons();
                $('#minimax_quote_tts_editor').remove();
                return;
            }
            h.versions.splice(h.activeIndex, 1);
            h.activeIndex = Math.min(h.activeIndex, h.versions.length - 1);
            saveSettingsDebounced(); refreshAllMessageButtons();
            render();
        });
        const invalidateBubbles = () => {
            const textEl = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
            if (textEl) textEl.removeAttribute('data-mm-bub-ver');
            setTimeout(() => { injectBubbles(id); refreshBubbleStates(id); refreshAllMessageButtons(); }, 100);
        };
        $('#minimax_quote_tts_editor .editor-close').on('click', () => { $('#minimax_quote_tts_editor').remove(); invalidateBubbles(); });
        $('#minimax_quote_tts_editor .edit-v').on('change input', function(){
            const p = $(this).data('prop'), idx = $(this).data('idx'), val = $(this).val();
            if(p === 'speaker'){ v.items[idx].speaker = val; const b = findCharacterBinding(val); if(b){ v.items[idx].options.model = b.model || s().model; v.items[idx].options.voiceId = b.voiceId || s().voiceId; render(); } }
            else { v.items[idx].options[p] = val; } v.items[idx].serverPath = null;
        });
        $('#minimax_quote_tts_editor .editor-save-only').on('click', () => { saveSettingsDebounced(); toastr.success('已保存'); });
        $('#minimax_quote_tts_editor .editor-confirm').on('click', () => { saveSettingsDebounced(); $('#minimax_quote_tts_editor').remove(); refreshAllMessageButtons(); invalidateBubbles(); });
        $('#minimax_quote_tts_editor select.edit-v').each(function(){ $(this).val(v.items[$(this).data('idx')].options.model); });
    }; render();
}

function refreshAllLlmPresetSelects() {
    const presets = s().llmPresets || [];
    const opts = '<option value="-1">-- 选择预设 --</option>' + presets.map((p, i) => `<option value="${i}">${escHtml(p.name)}</option>`).join('');
    document.querySelectorAll('.llm-preset-sel').forEach(el => {
        const cur = el.value;
        el.innerHTML = opts;
        if (Number(cur) >= 0 && Number(cur) < presets.length) el.value = cur;
    });
}

// ★ 修复1: 注入内联 CSS（确保面板一定能显示）
function injectStyles() {
    if (document.getElementById('mm-tts-inline-css')) return;
    const style = document.createElement('style');
    style.id = 'mm-tts-inline-css';
    style.textContent = `
/* ── 配置面板遮罩 ───────────────────────────── */
.mm-config-mask {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(4px);
    justify-content: center;
    align-items: center;
    padding: 16px;
}
.mm-config-mask.mm-config-open {
    display: flex !important;
}
.mm-config-dialog {
    width: min(680px, 96vw);
    max-height: 92vh;
    background: var(--SmartThemeBlurTintColor, #1a1c2a);
    color: var(--SmartThemeBodyColor, #ccc);
    border-radius: 16px;
    box-shadow: 0 12px 48px rgba(0,0,0,0.45);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.mm-config-header {
    display: flex;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
    gap: 8px;
}
.mm-config-close {
    background: none;
    border: none;
    color: inherit;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 4px 8px;
    opacity: 0.6;
    flex-shrink: 0;
}
.mm-config-close:hover { opacity: 1; }
.mm-config-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
}

/* ── Tab 导航 ───────────────────────────────── */
.mm-tab-bar {
    display: flex;
    gap: 2px;
    flex: 1;
    flex-wrap: wrap;
}
.mm-tab {
    background: transparent;
    border: none;
    color: inherit;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 8px 8px 0 0;
    font-size: 0.88rem;
    opacity: 0.55;
    white-space: nowrap;
}
.mm-tab:hover { opacity: 0.8; background: rgba(255,255,255,0.04); }
.mm-tab.active {
    opacity: 1;
    background: rgba(255,255,255,0.08);
    font-weight: 600;
}
.mm-tab-panel { display: none; }
.mm-tab-panel.active { display: block; }

/* ── 表单行 ─────────────────────────────────── */
.mm-config-dialog .mm-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
}
.mm-config-dialog .mm-row > label {
    min-width: 85px;
    flex-shrink: 0;
    font-size: 0.88rem;
    opacity: 0.8;
}
/* ★ 修复2: 约束 text_pole 宽度，防止拉长 */
.mm-config-dialog .text_pole {
    flex: 1;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    height: 34px !important;
    font-size: 0.88rem !important;
}
.mm-config-dialog textarea.text_pole {
    height: auto !important;
    min-height: 64px;
    resize: vertical;
}
.mm-config-dialog select.text_pole {
    flex: 1;
    min-width: 0;
}
.mm-config-dialog input[type="checkbox"] {
    flex: none;
    width: 18px;
    height: 18px;
}

/* ── 小标题 / 描述 / 提示 ────────────────────── */
.mm-section-title {
    font-weight: 600;
    font-size: 0.95rem;
    margin: 16px 0 8px;
    display: flex;
    align-items: center;
    gap: 10px;
}
.mm-desc {
    font-size: 0.82rem;
    opacity: 0.55;
    margin: 0 0 10px;
    line-height: 1.4;
}
.mm-hint {
    font-size: 0.8rem;
    opacity: 0.5;
    margin: 4px 0 10px;
}
.mm-inline-hint {
    font-size: 0.78rem;
    opacity: 0.5;
    white-space: nowrap;
}

/* ── 语音库行 ─────────────────────────────── */
.mm-voice-lib-row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    align-items: center;
}

/* ── 角色绑定行 ───────────────────────────── */
.mm-binding-row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    align-items: center;
    flex-wrap: wrap;
}
.mm-binding-row .text_pole {
    flex: 1;
    min-width: 80px;
}

/* ── 正则规则行 ───────────────────────────── */
.mm-rule-header-row {
    display: flex;
    gap: 6px;
    font-size: 0.78rem;
    opacity: 0.5;
    padding: 0 0 4px;
}
.mm-rule-header-row > span { flex: 1; }
.mm-rule-header-row > .mm-rule-toggle { flex: 0 0 20px; }
.mm-rule-header-row > .mm-rule-mode { flex: 0 0 68px; }
.mm-rule-header-row > .mm-rule-del { flex: 0 0 30px; }
.mm-rule-row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    align-items: center;
}
.mm-rule-row .text_pole { flex: 1; min-width: 0; }
.mm-rule-row .mm-rule-toggle { flex: 0 0 20px; }

/* ── VC 提示词块 ──────────────────────────── */
.mm-block-list { display: flex; flex-direction: column; gap: 6px; }
.mm-block {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 10px 12px;
    background: rgba(255,255,255,0.02);
}
.mm-block-header {
    display: flex;
    align-items: center;
    gap: 8px;
}
.mm-drag-handle {
    cursor: grab;
    font-size: 1.1rem;
    opacity: 0.4;
    user-select: none;
}
.mm-block-label { font-weight: 500; font-size: 0.9rem; }
.mm-block-hint { font-size: 0.78rem; opacity: 0.45; margin-top: 2px; padding-left: 38px; }
.mm-block-content { padding-left: 38px; }
.mm-block-textarea { width: 100% !important; }
.mm-dragging { opacity: 0.4; }
.mm-drag-over { border-color: rgba(110,160,255,0.5); }

/* ── 消息按钮 ─────────────────────────────── */
.mes_quote_tts { cursor: pointer; opacity: 0.5; }
.mes_quote_tts:hover { opacity: 0.85; }
.mes_quote_tts.ready { opacity: 1; color: #4caf50; }

/* ── 气泡 ─────────────────────────────────── */
.mm-bubble {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    margin: 0 2px;
    border-radius: 10px;
    background: rgba(110,160,255,0.12);
    cursor: pointer;
    font-size: 0.78rem;
    vertical-align: middle;
    transition: background 0.15s;
    white-space: nowrap;
}
.mm-bubble:hover { background: rgba(110,160,255,0.25); }
.mm-bubble i { font-size: 0.7rem; }
.mm-bubble-cached { background: rgba(76,175,80,0.15); }
.mm-bubble-cached:hover { background: rgba(76,175,80,0.3); }
.mm-bubble-loading { opacity: 0.5; pointer-events: none; }
.mm-bubble-playing { background: rgba(255,165,0,0.2); }
.mm-bubble-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed rgba(255,255,255,0.1);
}

/* ── 语音通话悬浮球 ───────────────────────── */
#vc-fab, #vrm-fab {
    position: fixed;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 99990;
    font-size: 1.2rem;
    color: #fff;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    touch-action: none;
    user-select: none;
    transition: transform 0.15s, box-shadow 0.15s;
}
#vc-fab {
    background: linear-gradient(135deg, #4caf50, #2e7d32);
}
#vc-fab.vc-fab-active {
    background: linear-gradient(135deg, #ef5350, #c62828);
}
#vrm-fab {
    background: linear-gradient(135deg, #42a5f5, #1565c0);
}
#vrm-fab.vc-fab-active {
    background: linear-gradient(135deg, #ef5350, #c62828);
}
#vc-fab:active, #vrm-fab:active { transform: scale(0.92); }

/* ── 语音通话弹窗 ─────────────────────────── */
#vc-dialog {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 99995;
    background: rgba(0,0,0,0.7);
    backdrop-filter: blur(8px);
    justify-content: center;
    align-items: center;
    padding: 20px;
}
#vc-dialog.vc-dialog-open { display: flex; }
.vc-card {
    width: min(360px, 90vw);
    background: rgba(30,32,48,0.95);
    border-radius: 24px;
    padding: 30px 24px 20px;
    text-align: center;
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
}
.vc-avatar-wrap {
    position: relative;
    width: 80px;
    height: 80px;
}
.vc-avatar-wrap img, .vc-avatar-placeholder {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    object-fit: cover;
}
.vc-avatar-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.08);
    font-size: 2rem;
    color: rgba(255,255,255,0.4);
}
.vc-ripple {
    position: absolute;
    inset: -8px;
    border-radius: 50%;
    border: 2px solid rgba(76,175,80,0.3);
    animation: vcRipple 2.5s ease-out infinite;
}
.vc-ripple.r2 { animation-delay: 0.8s; }
.vc-ripple.r3 { animation-delay: 1.6s; }
@keyframes vcRipple {
    0% { transform: scale(0.9); opacity: 0.7; }
    100% { transform: scale(1.6); opacity: 0; }
}
.vc-name { font-size: 1.2rem; font-weight: 600; color: #fff; }
.vc-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
    opacity: 0.6;
    color: #ccc;
}
.vc-dot { opacity: 0.4; }
#vc-canvas {
    width: 240px;
    height: 48px;
    border-radius: 8px;
}
.vc-log {
    width: 100%;
    max-height: 120px;
    overflow-y: auto;
    text-align: left;
    font-size: 0.82rem;
    line-height: 1.5;
    color: rgba(255,255,255,0.7);
    padding: 8px;
    background: rgba(0,0,0,0.15);
    border-radius: 8px;
}
.vc-log-line { margin-bottom: 4px; }
.vc-log-user { color: rgba(110,190,255,0.9); }
.vc-log-ai   { color: rgba(200,220,255,0.85); }
.vc-log-interim { opacity: 0.4; font-style: italic; }
.vc-controls {
    display: flex;
    gap: 16px;
    margin-top: 8px;
}
.vc-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 18px;
    border: none;
    border-radius: 14px;
    background: rgba(255,255,255,0.08);
    color: #fff;
    cursor: pointer;
    font-size: 0.78rem;
    transition: background 0.15s;
}
.vc-btn i { font-size: 1.1rem; }
.vc-btn:hover { background: rgba(255,255,255,0.14); }
.vc-btn-end { background: rgba(239,83,80,0.25); }
.vc-btn-end:hover { background: rgba(239,83,80,0.4); }
.vc-btn-muted { background: rgba(255,165,0,0.2); }

/* ── VRM 帧 ───────────────────────────────── */
#mm-vrm-frame {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 60vh;
    z-index: 99993;
    overflow: hidden;
}
html.mm-vc-active #mm-vrm-frame { display: block; }
html.mm-vc-active #sheld {
    margin-top: 60vh;
    height: 40vh !important;
    overflow-y: auto;
}
#vc-vrm-canvas {
    width: 100%;
    height: 100%;
    display: block;
}
#mm-vrm-hud {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 8px 12px;
    background: linear-gradient(transparent, rgba(0,0,0,0.5));
    display: flex;
    align-items: flex-end;
    gap: 10px;
}
.vrm-hud-log {
    flex: 1;
    max-height: 80px;
    font-size: 0.8rem;
}
.vrm-hud-controls {
    flex-shrink: 0;
}
#mm-vrm-info {
    display: none;
    position: fixed;
    top: calc(60vh - 36px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 99994;
    background: rgba(30,32,48,0.85);
    border-radius: 18px;
    padding: 6px 18px;
    text-align: center;
    color: #fff;
    font-size: 0.82rem;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    backdrop-filter: blur(4px);
}
html.mm-vc-active #mm-vrm-info { display: block; }
.mm-vrm-meta {
    display: flex;
    gap: 6px;
    justify-content: center;
    opacity: 0.6;
    font-size: 0.75rem;
}
.mm-vrm-dot { opacity: 0.4; }

/* ── 编辑器弹窗 ───────────────────────────── */
.minimax-tts-editor-mask {
    position: fixed;
    inset: 0;
    z-index: 99998;
    background: rgba(0,0,0,0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 16px;
}
.minimax-tts-editor-dialog {
    width: min(600px, 94vw);
    max-height: 88vh;
    background: var(--SmartThemeBlurTintColor, #1a1c2a);
    color: var(--SmartThemeBodyColor, #ccc);
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.minimax-tts-editor-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    gap: 8px;
}
.minimax-tts-editor-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
}
.minimax-tts-editor-item {
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
}
.minimax-tts-editor-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}
.minimax-tts-editor-row-flex {
    display: flex;
    align-items: center;
    gap: 6px;
}
.minimax-tts-editor-row-flex label {
    min-width: 36px;
    font-size: 0.82rem;
    opacity: 0.7;
}
.minimax-tts-editor-actions {
    display: flex;
    gap: 10px;
    padding: 12px 16px;
    border-top: 1px solid rgba(255,255,255,0.08);
}
.minimax-tts-editor-actions .menu_button { flex: 1; }
`;
    document.head.appendChild(style);
}

function createUi() {
    injectStyles(); // 

    const wandHtml = `<div id="mm_wand_item" class="list-group-item flex-container flexGap5" title="MiniMax TTS 配置"><div class="fa-solid fa-volume-high extensionsMenuExtensionButton"></div>MiniMax语音</div>`;
    $('#extensionsMenu').append(wandHtml);
    $('#mm_wand_item').on('click', () => {
        const menu = document.getElementById('extensionsMenu');
        if (menu) menu.style.display = 'none';
        openConfigPanel();
    });

    loadSettings();
    syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());
    refreshAllLlmPresetSelects();
    eventSource.on(event_types.CHARACTER_SELECTED, () => { if (document.getElementById('mm_b_rows')) renderBindings(); });
    eventSource.on(event_types.CHAT_CHANGED, () => { if (document.getElementById('mm_b_rows')) renderBindings(); });
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────────

function getDefaultVcBlocks() {
    return [
        { id: 'charDesc',   enabled: true,  label: '角色卡描述',    editable: false, hint: '（自动读取当前角色卡描述）' },
        { id: 'worldBook',  enabled: false, label: '世界书',        editable: false, hint: '（世界书注入内容，内容多时注意 token 消耗）' },
        { id: 'context',    enabled: true,  label: '上下文对话',    editable: false, hint: '（酒馆聊天记录，见下方条数设置）' },
        { id: 'vcSystem',   enabled: true,  label: '通话系统提示词', editable: true  },
        { id: 'vrmActions', enabled: false, label: 'VRM表情/动作',  editable: false, hint: '（视频通话时让 AI 输出表情动作标签，语音通话无效）' },
    ];
}

function renderVoiceLibrary() {
    const container = document.getElementById('mm_voice_lib_rows');
    if (!container) return;
    container.innerHTML = '';
    const lib = s().voiceLibrary || [];
    lib.forEach((v, i) => {
        const el = document.createElement('div');
        el.className = 'mm-voice-lib-row';
        el.innerHTML = `
            <input class="text_pole vl-name" placeholder="名称（如：路人甲女声）" value="${escHtml(v.name||'')}">
            <input class="text_pole vl-id"   placeholder="voiceId" value="${escHtml(v.voiceId||'')}">
            <button class="menu_button vl-del" style="padding:4px 10px;flex-shrink:0">×</button>
        `;
        el.querySelector('.vl-name').addEventListener('input', function() { lib[i].name = this.value; saveSettingsDebounced(); refreshVoiceSelects(); });
        el.querySelector('.vl-id').addEventListener('input',   function() { lib[i].voiceId = this.value; saveSettingsDebounced(); });
        el.querySelector('.vl-del').addEventListener('click',  () => { lib.splice(i, 1); saveSettingsDebounced(); renderVoiceLibrary(); refreshVoiceSelects(); });
        container.appendChild(el);
    });
}

function refreshVoiceSelects() {
    const lib = s().voiceLibrary || [];
    const opts = '<option value="">直接输入</option>' + lib.map(v => `<option value="${escHtml(v.voiceId)}">${escHtml(v.name)}</option>`).join('');
    document.querySelectorAll('.mm-voice-sel').forEach(el => {
        const cur = el.value;
        el.innerHTML = opts;
        if (cur && [...el.options].some(o => o.value === cur)) el.value = cur;
    });
}

function renderRules() {
    const container = document.getElementById('mm_rule_rows');
    if (!container) return;
    container.innerHTML = '';
    const rules = s().regexRules || [];
    rules.forEach((rule, i) => {
        const el = document.createElement('div');
        el.className = 'mm-rule-row';
        el.innerHTML = `
            <input type="checkbox" class="mm-rule-toggle" ${rule.enabled ? 'checked' : ''} title="启用/禁用">
            <input class="text_pole mm-rule-name"    placeholder="规则名" value="${escHtml(rule.name||'')}">
            <input class="text_pole mm-rule-pattern" placeholder="正则 或 /pattern/" value="${escHtml(rule.pattern||'')}">
            <select class="text_pole mm-rule-mode" style="max-width:68px">
                <option value="extract" ${rule.mode==='extract'?'selected':''}>提取</option>
                <option value="exclude" ${rule.mode==='exclude'?'selected':''}>排除</option>
            </select>
            <button class="menu_button mm-rule-del" title="删除">×</button>
        `;
        el.querySelector('.mm-rule-toggle').addEventListener('change', function() { rules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input',    function() { rules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function() { rules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change',   function() { rules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click',     () => { rules.splice(i, 1); saveSettingsDebounced(); renderRules(); });
        container.appendChild(el);
    });
}

function renderPreProcessRules() {
    const container = document.getElementById('mm_pre_rule_rows');
    if (!container) return;
    container.innerHTML = '';
    const rules = s().llmPreProcessRules || [];
    rules.forEach((rule, i) => {
        const el = document.createElement('div');
        el.className = 'mm-rule-row';
        el.innerHTML = `
            <input type="checkbox" class="mm-rule-toggle" ${rule.enabled ? 'checked' : ''} title="启用/禁用">
            <input class="text_pole mm-rule-name"    placeholder="规则名" value="${escHtml(rule.name||'')}">
            <input class="text_pole mm-rule-pattern" placeholder="正则 或 /pattern/" value="${escHtml(rule.pattern||'')}">
            <select class="text_pole mm-rule-mode" style="max-width:68px">
                <option value="extract" ${rule.mode==='extract'?'selected':''}>提取</option>
                <option value="exclude" ${rule.mode==='exclude'?'selected':''}>排除</option>
            </select>
            <button class="menu_button mm-rule-del" title="删除">×</button>
        `;
        el.querySelector('.mm-rule-toggle').addEventListener('change', function() { rules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input',    function() { rules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function() { rules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change',   function() { rules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click',     () => { rules.splice(i, 1); saveSettingsDebounced(); renderPreProcessRules(); });
        container.appendChild(el);
    });
}

function renderVcBlocks() {
    if (!s().vcPromptBlocks) s().vcPromptBlocks = getDefaultVcBlocks();
    const blocks = s().vcPromptBlocks;
    const container = document.getElementById('mm_vc_blocks');
    if (!container) return;
    container.innerHTML = '';
    const BUILTIN_IDS = new Set(['charDesc', 'worldBook', 'context', 'vcSystem', 'vrmActions']);
    blocks.forEach((block, i) => {
        const el = document.createElement('div');
        el.className = 'mm-block mm-draggable';
        el.draggable = true;
        el.dataset.idx = i;
        const isBuiltin = BUILTIN_IDS.has(block.id);
        const textareaVal = block.id === 'vcSystem' ? escHtml(s().vcSystemPrompt||'') : escHtml(block.content||'');
        el.innerHTML = `
            <div class="mm-block-header">
                <span class="mm-drag-handle" title="拖拽排序">≡</span>
                <input type="checkbox" class="mm-block-toggle" ${block.enabled ? 'checked' : ''}>
                <span class="mm-block-label">${escHtml(block.label)}</span>
                <div style="display:flex;gap:4px;margin-left:auto">
                    ${block.editable ? `<button class="mm-rename-block menu_button" title="重命名" style="padding:2px 8px;font-size:0.78rem">✎</button>` : ''}
                    ${block.editable ? `<button class="mm-expand-block menu_button" title="展开编辑" style="padding:2px 8px;font-size:0.78rem">⛶</button>` : ''}
                    ${!isBuiltin ? `<button class="mm-del-block menu_button" title="删除" style="padding:2px 8px;font-size:0.78rem">×</button>` : ''}
                </div>
            </div>
            ${block.hint ? `<div class="mm-block-hint">${block.hint}</div>` : ''}
            ${block.id === 'worldBook' ? `<div class="mm-block-content" style="margin-top:6px;display:flex;align-items:center;gap:8px"><span class="mm-wb-count" style="font-size:0.8rem;opacity:0.65">${block.selectedEntries?.length ? `已选 ${block.selectedEntries.length} 条` : '全部注入（未指定条目）'}</span><button class="menu_button mm-wb-manage" style="padding:2px 10px;font-size:0.78rem">选择条目</button></div>` : ''}
            ${block.editable ? `<div class="mm-block-content"><textarea class="mm-block-textarea text_pole" style="min-height:64px;margin-top:6px;width:100%">${textareaVal}</textarea></div>` : ''}
        `;
        el.querySelector('.mm-block-toggle').addEventListener('change', function() {
            s().vcPromptBlocks[i].enabled = this.checked; saveSettingsDebounced();
        });
        if (block.editable) {
            el.querySelector('.mm-block-textarea').addEventListener('input', function() {
                if (block.id === 'vcSystem') s().vcSystemPrompt = this.value;
                else s().vcPromptBlocks[i].content = this.value;
                saveSettingsDebounced();
            });
        }
        el.querySelector('.mm-wb-manage')?.addEventListener('click', async () => {
            const blockRef = s().vcPromptBlocks[i];
            let entries;
            try {
                entries = await loadAllWbEntries();
            } catch (e) {
                toastr.error('加载世界书失败: ' + e.message);
                return;
            }

            if (!entries.length) {
                const ctx = getContext();
                const hints = [
                    '未找到任何世界书条目。请检查：',
                    '',
                    '1. 是否已在酒馆中创建或导入了世界书？',
                    '2. 世界书是否已绑定到当前角色或全局启用？',
                    `   当前角色: ${ctx.name2 || '(无)'}`,
                    `   角色绑定世界书: ${ctx.characters?.[ctx.characterId]?.data?.extensions?.world || '(无)'}`,
                    `   聊天绑定世界书: ${ctx.chatMetadata?.world_info || '(无)'}`,
                    '',
                    '提示：在酒馆的世界书面板中为角色绑定世界书，或全局启用后重试。',
                ];
                await callGenericPopup(
                    `<div style="white-space:pre-wrap;font-size:0.9rem;line-height:1.6">${hints.join('\n')}</div>`,
                    POPUP_TYPE.TEXT,
                    '未找到世界书',
                );
                return;
            }

            const selected = new Set(blockRef.selectedEntries || []);

            // 按世界书名分组
            const grouped = new Map();
            for (const entry of entries) {
                if (!grouped.has(entry.worldName)) {
                    grouped.set(entry.worldName, { source: entry.source || '📚', entries: [] });
                }
                grouped.get(entry.worldName).entries.push(entry);
            }

            // 构建弹窗
            const wrap = document.createElement('div');
            wrap.style.cssText = 'max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:0;padding:0';

            // 搜索框
            const searchBox = document.createElement('input');
            searchBox.type = 'text';
            searchBox.placeholder = '🔍 搜索条目名称 / 关键词 / 内容...';
            searchBox.className = 'text_pole';
            searchBox.style.cssText = 'margin:0 0 10px;position:sticky;top:0;z-index:1;background:var(--SmartThemeBlurTintColor,#1a1c2a)';
            wrap.appendChild(searchBox);

            // 统计栏
            const statsBar = document.createElement('div');
            statsBar.style.cssText = 'font-size:0.78rem;opacity:0.55;margin-bottom:8px;padding:0 4px;position:sticky;top:38px;z-index:1;background:var(--SmartThemeBlurTintColor,#1a1c2a)';
            const updateStats = () => {
                statsBar.textContent = `共 ${grouped.size} 本世界书，${entries.length} 个条目，已选 ${selected.size} 个`;
            };
            updateStats();
            wrap.appendChild(statsBar);

            const allEntryEls = [];

            for (const [worldName, group] of grouped) {
                const groupEl = document.createElement('div');
                groupEl.style.cssText = 'margin-bottom:8px';

                const header = document.createElement('div');
                header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 8px 6px;cursor:pointer;border-radius:8px;background:rgba(128,128,128,0.08);user-select:none';
                header.innerHTML = `
                    <span style="font-size:0.72rem;opacity:0.45;transform:rotate(0deg);transition:transform 0.2s;display:inline-block" class="mm-wb-arrow">▶</span>
                    <span style="font-weight:600;font-size:0.92rem;flex:1">${escHtml(worldName)}</span>
                    <span style="font-size:0.72rem;opacity:0.5;padding:2px 8px;border-radius:10px;background:rgba(128,128,128,0.12)">${escHtml(group.source)}</span>
                    <span style="font-size:0.72rem;opacity:0.45">${group.entries.length} 条</span>
                `;

                const body = document.createElement('div');
                body.style.cssText = 'display:none;flex-direction:column;gap:2px;padding:4px 0 0 18px';

                let expanded = false;
                header.addEventListener('click', (e) => {
                    if (e.target.closest('.mm-wb-sel-all')) return;
                    expanded = !expanded;
                    body.style.display = expanded ? 'flex' : 'none';
                    header.querySelector('.mm-wb-arrow').style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
                });

                // 全选按钮
                const selAllBtn = document.createElement('button');
                selAllBtn.className = 'menu_button mm-wb-sel-all';
                selAllBtn.style.cssText = 'padding:1px 8px;font-size:0.72rem;margin-left:4px';
                selAllBtn.textContent = '全选';
                selAllBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const groupKeys = group.entries.map(en => en.key);
                    const allSelected = groupKeys.every(k => selected.has(k));
                    for (const ent of group.entries) {
                        if (allSelected) selected.delete(ent.key);
                        else selected.add(ent.key);
                    }
                    allEntryEls.forEach(({ cb, entry: ent }) => {
                        if (ent.worldName === worldName) cb.checked = selected.has(ent.key);
                    });
                    selAllBtn.textContent = allSelected ? '全选' : '取消全选';
                    updateStats();
                });
                header.appendChild(selAllBtn);
                groupEl.appendChild(header);

                // 条目
                for (const entry of group.entries) {
                    const row = document.createElement('label');
                    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:7px 8px;border-radius:6px;background:rgba(128,128,128,0.03);transition:background 0.1s';
                    row.addEventListener('mouseenter', () => row.style.background = 'rgba(128,128,128,0.1)');
                    row.addEventListener('mouseleave', () => row.style.background = 'rgba(128,128,128,0.03)');

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = selected.has(entry.key);
                    cb.style.cssText = 'margin-top:3px;flex-shrink:0';
                    cb.addEventListener('change', () => {
                        cb.checked ? selected.add(entry.key) : selected.delete(entry.key);
                        updateStats();
                    });

                    const info = document.createElement('div');
                    info.style.cssText = 'flex:1;min-width:0;font-size:0.84rem';

                    const titleLine = document.createElement('div');
                    titleLine.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
                    titleLine.innerHTML = `<span style="font-weight:600">${escHtml(entry.title)}</span>`;
                    if (entry.disabled) {
                        titleLine.innerHTML += `<span style="font-size:0.68rem;color:#ef5350;background:rgba(239,83,80,0.1);padding:1px 6px;border-radius:8px">已禁用</span>`;
                    }
                    info.appendChild(titleLine);

                    // 关键词标签
                    const keys = entry.keys || [];
                    if (keys.length) {
                        const keysEl = document.createElement('div');
                        keysEl.style.cssText = 'margin-top:2px;display:flex;flex-wrap:wrap;gap:3px';
                        keys.slice(0, 8).forEach(k => {
                            const tag = document.createElement('span');
                            tag.style.cssText = 'font-size:0.68rem;padding:1px 6px;border-radius:8px;background:rgba(110,160,255,0.1);color:rgba(110,160,255,0.8)';
                            tag.textContent = k;
                            keysEl.appendChild(tag);
                        });
                        if (keys.length > 8) {
                            const more = document.createElement('span');
                            more.style.cssText = 'font-size:0.68rem;opacity:0.4';
                            more.textContent = `+${keys.length - 8}`;
                            keysEl.appendChild(more);
                        }
                        info.appendChild(keysEl);
                    }

                    // 可展开内容预览
                    if (entry.content) {
                        const preview = document.createElement('div');
                        preview.style.cssText = 'opacity:0.45;font-size:0.76rem;margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;cursor:pointer;line-height:1.4';
                        preview.textContent = entry.content.slice(0, 200) + (entry.content.length > 200 ? '…' : '');
                        preview.title = '点击展开/收起';
                        let contentExpanded = false;
                        preview.addEventListener('click', (ev) => {
                            ev.preventDefault(); ev.stopPropagation();
                            contentExpanded = !contentExpanded;
                            if (contentExpanded) {
                                preview.style.display = 'block';
                                preview.style.webkitLineClamp = 'unset';
                                preview.textContent = entry.content;
                            } else {
                                preview.style.display = '-webkit-box';
                                preview.style.webkitLineClamp = '2';
                                preview.textContent = entry.content.slice(0, 200) + (entry.content.length > 200 ? '…' : '');
                            }
                        });
                        info.appendChild(preview);
                    }

                    row.appendChild(cb);
                    row.appendChild(info);
                    body.appendChild(row);
                    allEntryEls.push({ el: row, entry, cb });
                }

                groupEl.appendChild(body);
                wrap.appendChild(groupEl);
            }

            // 搜索
            searchBox.addEventListener('input', () => {
                const q = searchBox.value.trim().toLowerCase();
                for (const { el: rowEl, entry } of allEntryEls) {
                    if (!q) { rowEl.style.display = ''; continue; }
                    const match =
                        entry.title.toLowerCase().includes(q) ||
                        entry.content.toLowerCase().includes(q) ||
                        entry.worldName.toLowerCase().includes(q) ||
                        (entry.keys || []).some(k => k.toLowerCase().includes(q));
                    rowEl.style.display = match ? '' : 'none';
                }
                if (q) {
                    wrap.querySelectorAll('.mm-wb-arrow').forEach(arrow => {
                        arrow.style.transform = 'rotate(90deg)';
                        const bd = arrow.closest('div')?.parentElement?.querySelector('div:last-child');
                        if (bd) bd.style.display = 'flex';
                    });
                }
            });

            const ok = await callGenericPopup(
                wrap, POPUP_TYPE.CONFIRM,
                `选择世界书条目 (${entries.length} 条来自 ${grouped.size} 本)`,
                { wide: true, okButton: '确认', cancelButton: '取消' },
            );
            if (ok) {
                blockRef.selectedEntries = [...selected];
                saveSettingsDebounced();
                renderVcBlocks();
            }
        });

        el.querySelector('.mm-del-block')?.addEventListener('click', () => {
            s().vcPromptBlocks.splice(i, 1); saveSettingsDebounced(); renderVcBlocks();
        });
        el.querySelector('.mm-rename-block')?.addEventListener('click', () => {
            const name = prompt('重命名块：', block.label);
            if (name !== null && name.trim()) {
                s().vcPromptBlocks[i].label = name.trim();
                saveSettingsDebounced(); renderVcBlocks();
            }
        });
        el.querySelector('.mm-expand-block')?.addEventListener('click', async () => {
            const ta = document.createElement('textarea');
            ta.className = 'text_pole';
            ta.style.cssText = 'width:100%;height:45vh;resize:none;font-family:inherit;box-sizing:border-box';
            ta.value = block.id === 'vcSystem' ? (s().vcSystemPrompt || '') : (block.content || '');
            const ok = await callGenericPopup(ta, POPUP_TYPE.CONFIRM, '', { wide: true, okButton: '确认', cancelButton: '取消' });
            if (ok) {
                if (block.id === 'vcSystem') s().vcSystemPrompt = ta.value;
                else s().vcPromptBlocks[i].content = ta.value;
                saveSettingsDebounced(); renderVcBlocks();
            }
        });
        el.addEventListener('dragstart', e => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
            el.classList.add('mm-dragging');
        });
        el.addEventListener('dragend',  () => el.classList.remove('mm-dragging'));
        el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('mm-drag-over'); });
        el.addEventListener('dragleave',() => el.classList.remove('mm-drag-over'));
        el.addEventListener('drop',     e => {
            e.preventDefault(); el.classList.remove('mm-drag-over');
            const fromIdx = Number(e.dataTransfer.getData('text/plain')), toIdx = i;
            if (fromIdx === toIdx) return;
            const arr = s().vcPromptBlocks;
            const [moved] = arr.splice(fromIdx, 1);
            arr.splice(toIdx, 0, moved);
            saveSettingsDebounced(); renderVcBlocks();
        });
        container.appendChild(el);
    });
}

function renderBindings() {
    const c = getContext(), id = c.characterId || c.character_id || c.name2 || 'global';
    if (!s().characterBindingsMap[id]) s().characterBindingsMap[id] = [];
    const container = $('#mm_b_rows');
    if (!container.length) return;
    container.empty();
    const lib = s().voiceLibrary || [];
    s().characterBindingsMap[id].forEach((b, i) => {
        const voiceOpts = '<option value="">直接输入</option>' + lib.map(v => `<option value="${escHtml(v.voiceId)}">${escHtml(v.name)}</option>`).join('');
        const libMatch = lib.find(v => v.voiceId === b.voiceId);
        const row = $(`<div class="mm-binding-row">
            <select class="text_pole b-type">
                <option value="${TARGET_TYPE.CURRENT_CHARACTER}">${escHtml(c.name2||'角色')}</option>
                <option value="${TARGET_TYPE.CURRENT_USER}">${escHtml(c.name1||'你')}</option>
                <option value="${TARGET_TYPE.CUSTOM}">自定义</option>
            </select>
            <input class="text_pole b-name" placeholder="名称" value="${escHtml(b.customName||'')}" style="${b.targetType===TARGET_TYPE.CUSTOM?'':'display:none'}">
            <select class="text_pole b-model">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select>
            <select class="text_pole b-voice-lib mm-voice-sel">${voiceOpts}</select>
            <input class="text_pole b-voice" placeholder="voiceId" value="${escHtml(libMatch?'':b.voiceId||'')}" style="${libMatch?'display:none':''}">
            <button class="menu_button b-del" style="padding:4px 10px;flex-shrink:0">×</button>
        </div>`);
        row.find('.b-type').val(b.targetType).on('change', function() { b.targetType=$(this).val(); renderBindings(); saveSettingsDebounced(); });
        row.find('.b-name').on('input', function() { b.customName=$(this).val(); saveSettingsDebounced(); });
        row.find('.b-model').val(b.model || s().model).on('change', function() { b.model=$(this).val(); saveSettingsDebounced(); });
        row.find('.b-voice-lib').val(libMatch ? b.voiceId : '').on('change', function() {
            const v = $(this).val(); b.voiceId = v;
            row.find('.b-voice').toggle(!v).val(''); saveSettingsDebounced();
        });
        row.find('.b-voice').on('input', function() { b.voiceId=$(this).val(); saveSettingsDebounced(); });
        row.find('.b-del').on('click', () => { s().characterBindingsMap[id].splice(i, 1); renderBindings(); saveSettingsDebounced(); });
        container.append(row);
    });
}

function renderRegexPresets() {
    const sel = document.getElementById('mm_regex_presets');
    if (!sel) return;
    sel.innerHTML = '<option value="-1">-- 选择预设 --</option>';
    (s().regexPresets || []).forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i; opt.textContent = p.name;
        sel.appendChild(opt);
    });
}

// ★ 修复7: 每次打开面板时刷新字段值
function populateConfigFields() {
    const set = s();
    const el = id => document.getElementById(id);
    if (!el('mm_key')) return;

    el('mm_key').value     = set.apiKey  || '';
    el('mm_gid').value     = set.groupId || '';
    el('mm_apihost').value = set.apiHost || DEFAULT_API_HOST;
    el('mm_model').value   = set.model   || 'speech-02-hd';
    el('mm_speed').value   = set.speed   ?? 1;
    el('mm_vol').value     = set.vol     ?? 1;
    el('mm_tts_lang').value       = set.ttsLanguage || '';
    el('mm_autoplay').checked    = set.autoPlay !== false;
    el('mm_show_bubbles').checked = set.showBubbles || false;

    renderVoiceLibrary(); refreshVoiceSelects();
    const voiceSel   = el('mm_voice_sel');
    const voiceInput = el('mm_voice');
    const libMatch   = (set.voiceLibrary||[]).find(v => v.voiceId === set.voiceId);
    if (libMatch) { voiceSel.value = set.voiceId; voiceInput.style.display = 'none'; }
    else { voiceSel.value = ''; voiceInput.value = set.voiceId || ''; voiceInput.style.display = ''; }

    el('mm_f_en').checked       = set.formatterEnabled || false;
    el('mm_f_prompt').value     = set.formatterSystemPrompt || '';

    refreshAllLlmPresetSelects();
    if ((s().llmPresets || []).length > 0) {
        el('mm_llm_presets').value = 0;
        loadLlmPresetFieldsGlobal(0);
    }
    if (set.formatterPresetIdx >= 0) el('mm_f_preset_sel').value = set.formatterPresetIdx;

    el('mm_vc_enabled').checked = set.vcEnabled !== false;
    el('mm_vc_inject').checked  = set.vcInjectOnEnd !== false;
    if (set.vcLlmPresetIdx >= 0) el('mm_vc_llm_preset').value = set.vcLlmPresetIdx;
    el('mm_vc_ctx_count').value = set.vcContextCount || 10;

    renderRules(); renderRegexPresets(); renderPreProcessRules();
    renderVcBlocks(); renderBindings();
}

// 全局函数，用于加载 LLM 预设字段
function loadLlmPresetFieldsGlobal(i) {
    const p = (s().llmPresets || [])[i]; if (!p) return;
    document.getElementById('mm_llm_url').value    = p.url    || '';
    document.getElementById('mm_llm_key').value    = p.key    || '';
    document.getElementById('mm_llm_format').value = p.format || API_FORMATS.OAI;
    document.getElementById('mm_llm_model').value  = p.model  || '';
    document.getElementById('mm_llm_model').style.display     = '';
    document.getElementById('mm_llm_model_sel').style.display = 'none';
}

function openConfigPanel() {
    if (!document.getElementById('mm-config-mask')) {
        const panelHtml = `
<div id="mm-config-mask" class="mm-config-mask">
  <div id="mm-config-dialog" class="mm-config-dialog">
    <div class="mm-config-header">
      <div class="mm-tab-bar" role="tablist">
        <button class="mm-tab active" data-tab="tts">TTS配置</button>
        <button class="mm-tab" data-tab="llm">LLM预设</button>
        <button class="mm-tab" data-tab="format">格式化</button>
        <button class="mm-tab" data-tab="vc">语音通话</button>
        <button class="mm-tab" data-tab="vrm">视频通话</button>
      </div>
      <button class="mm-config-close" title="关闭">✕</button>
    </div>
    <div class="mm-config-body">

      <!-- Tab: TTS配置 -->
      <div class="mm-tab-panel active" data-panel="tts">
        <p class="mm-desc">配置 MiniMax TTS API 连接参数及默认音色。</p>
        <div class="mm-row"><label>API Key</label><input id="mm_key" class="text_pole" type="password" autocomplete="off"></div>
        <div class="mm-row"><label>Group ID</label><input id="mm_gid" class="text_pole" type="text"></div>
        <div class="mm-row"><label>API 节点</label><select id="mm_apihost" class="text_pole">${API_HOST_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
        <div class="mm-row"><label>默认模型</label><select id="mm_model" class="text_pole">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
        <div class="mm-row">
          <label>默认语音</label>
          <select id="mm_voice_sel" class="text_pole mm-voice-sel" style="flex:1"></select>
          <input id="mm_voice" class="text_pole" placeholder="voiceId" style="max-width:160px">
        </div>
        <div class="mm-row"><label>语速</label><input id="mm_speed" class="text_pole" type="number" step="0.1" min="0.5" max="2" style="max-width:80px"></div>
        <div class="mm-row"><label>音量</label><input id="mm_vol" class="text_pole" type="number" step="0.1" min="0" max="10" style="max-width:80px"></div>
        <div class="mm-row"><label>语言</label>
          <select id="mm_tts_lang" class="text_pole">
            <option value="">自动（Auto）</option>
            <option value="zh">中文 (zh)</option>
            <option value="en">English (en)</option>
            <option value="ja">日本語 (ja)</option>
            <option value="ko">한국어 (ko)</option>
            <option value="fr">Français (fr)</option>
            <option value="de">Deutsch (de)</option>
            <option value="es">Español (es)</option>
            <option value="pt">Português (pt)</option>
            <option value="id">Indonesia (id)</option>
            <option value="ar">العربية (ar)</option>
          </select>
          <span class="mm-inline-hint">克隆声音使用时建议明确指定语言</span>
        </div>
        <div class="mm-row"><label>自动播放</label><input id="mm_autoplay" type="checkbox"></div>
        <div class="mm-row"><label>语音气泡</label><input id="mm_show_bubbles" type="checkbox"><span class="mm-inline-hint">在消息下方注入气泡，点击气泡单独收听该段语音</span></div>
        <div class="mm-row"><button id="mm_test_tts" class="menu_button"><i class="fa-solid fa-play"></i> 测试语音</button></div>
        <div class="mm-section-title">语音库 <button id="mm_add_voice" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">为语音 ID 起名，便于在角色绑定中按名选择。</p>
        <div id="mm_voice_lib_rows" class="mm-voice-lib-list"></div>
        <div class="mm-section-title" style="margin-top:16px">角色绑定 <button id="mm_add_b" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">为当前角色卡的各角色分配专属音色，优先级高于默认语音。</p>
        <div id="mm_b_rows"></div>
      </div>

      <!-- Tab: LLM预设 -->
      <div class="mm-tab-panel" data-panel="llm">
        <p class="mm-desc">管理用于格式化和语音通话的 LLM API 预设。</p>
        <div class="mm-row">
          <label>预设</label>
          <select id="mm_llm_presets" class="text_pole llm-preset-sel"></select>
          <button id="mm_llm_save_p" class="menu_button">保存</button>
          <button id="mm_llm_upd_p" class="menu_button">更新</button>
          <button id="mm_llm_del_p" class="menu_button">删除</button>
        </div>
        <div class="mm-row"><label>接口格式</label><select id="mm_llm_format" class="text_pole"><option value="${API_FORMATS.OAI}">OpenAI</option><option value="${API_FORMATS.GOOGLE}">Google Gemini</option></select></div>
        <div class="mm-row"><label>API 地址</label><input id="mm_llm_url" class="text_pole" type="text" placeholder="https://api.openai.com/v1"></div>
        <div class="mm-row"><label>API 密钥</label><input id="mm_llm_key" class="text_pole" type="password" autocomplete="off"></div>
        <div class="mm-row"><label>AI 模型</label><input id="mm_llm_model" class="text_pole" type="text"><select id="mm_llm_model_sel" class="text_pole" style="display:none"></select><button id="mm_llm_fetch" class="menu_button">获取</button><button id="mm_llm_test_conn" class="menu_button">测试</button></div>
      </div>

      <!-- Tab: 格式化 -->
      <div class="mm-tab-panel" data-panel="format">
        <p class="mm-desc">两种格式化方式：正则规则手动提取朗读内容；启用副 LLM 后交由 AI 结构化处理（支持多角色/情感），两者互斥。</p>
        <div class="mm-section-title">正则文本规则 <button id="mm_add_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <div class="mm-rule-header-row">
          <span class="mm-rule-toggle"></span>
          <span class="mm-rule-name">名称</span>
          <span class="mm-rule-pattern">正则表达式</span>
          <span class="mm-rule-mode">模式</span>
          <span class="mm-rule-del"></span>
        </div>
        <div id="mm_rule_rows"></div>
        <div class="mm-section-title" style="margin-top:12px">规则预设</div>
        <div class="mm-row" style="flex-wrap:wrap;gap:6px">
          <select id="mm_regex_presets" class="text_pole" style="min-width:120px;flex:1"></select>
          <button id="mm_regex_save_p" class="menu_button">保存</button>
          <button id="mm_regex_upd_p" class="menu_button">更新</button>
          <button id="mm_regex_del_p" class="menu_button">删除</button>
          <button id="mm_regex_export" class="menu_button">导出</button>
          <button id="mm_regex_import" class="menu_button">导入</button>
        </div>
        <div class="mm-section-title" style="margin-top:16px">副 LLM 格式化</div>
        <div class="mm-row"><label>启用格式化</label><input id="mm_f_en" type="checkbox"></div>
        <div class="mm-row"><label>LLM预设</label><select id="mm_f_preset_sel" class="text_pole llm-preset-sel"></select></div>
        <div class="mm-row" style="flex-wrap:wrap;gap:6px">
          <label style="min-width:85px">模板</label>
          <select id="mm_f_templates" class="text_pole" style="min-width:120px;flex:1"></select>
          <button id="mm_f_save_t" class="menu_button">保存</button>
          <button id="mm_f_upd_t" class="menu_button">更新</button>
          <button id="mm_f_del_t" class="menu_button">删除</button>
          <button id="mm_f_export_t" class="menu_button">导出</button>
          <button id="mm_f_import_t" class="menu_button">导入</button>
        </div>
        <div class="mm-row" style="align-items:flex-start">
          <label style="padding-top:6px">系统提示词</label>
          <textarea id="mm_f_prompt" class="text_pole" style="flex:1;width:0"></textarea>
        </div>
        <div class="mm-section-title" style="margin-top:16px">预处理规则 <button id="mm_add_pre_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">发送给副LLM或语音通话LLM之前，对消息文本执行正则处理（如剔除 &lt;think&gt; 思维链标签）。</p>
        <div class="mm-rule-header-row">
          <span class="mm-rule-toggle"></span>
          <span class="mm-rule-name">名称</span>
          <span class="mm-rule-pattern">正则表达式</span>
          <span class="mm-rule-mode">模式</span>
          <span class="mm-rule-del"></span>
        </div>
        <div id="mm_pre_rule_rows"></div>
      </div>

      <!-- Tab: 语音通话 -->
      <div class="mm-tab-panel" data-panel="vc">
        <p class="mm-desc">实时语音通话。启用后悬浮球出现，点击发起通话。</p>
        <div class="mm-row"><label>启用通话</label><input id="mm_vc_enabled" type="checkbox"></div>
        <div class="mm-row"><label>LLM 预设</label><select id="mm_vc_llm_preset" class="text_pole llm-preset-sel"></select></div>
        <div class="mm-row">
          <label>挂断注入</label>
          <input id="mm_vc_inject" type="checkbox">
          <span class="mm-inline-hint">通话结束后把记录注入聊天</span>
        </div>
        <div class="mm-section-title" style="margin-top:16px">通话提示词</div>
        <div class="mm-row" style="flex-wrap:wrap;gap:6px">
          <select id="mm_vc_templates" class="text_pole" style="min-width:120px;flex:1"></select>
          <button id="mm_vc_save_t" class="menu_button">保存</button>
          <button id="mm_vc_upd_t" class="menu_button">更新</button>
          <button id="mm_vc_del_t" class="menu_button">删除</button>
          <button id="mm_vc_export_t" class="menu_button">导出</button>
          <button id="mm_vc_import_t" class="menu_button">导入</button>
        </div>
        <p class="mm-hint">拖拽 ≡ 可调整顺序，☑ 开关模块。</p>
        <div id="mm_vc_blocks" class="mm-block-list"></div>
        <div class="mm-row" style="margin-top:12px">
          <label>上下文条数</label>
          <input id="mm_vc_ctx_count" class="text_pole" type="number" style="max-width:70px">
          <span class="mm-inline-hint">条（注入通话前）</span>
        </div>
        <div class="mm-row" style="margin-top:6px">
          <button id="mm_vc_add_block" class="menu_button"><i class="fa-solid fa-plus"></i> 添加自定义块</button>
        </div>
      </div>

      <!-- Tab: 视频通话 -->
      <div class="mm-tab-panel" data-panel="vrm">
        <p class="mm-desc">通话时渲染 VRM 3D 角色，支持实时口型同步与情感表情驱动。</p>
        <div class="mm-section-title">基本设置</div>
        <div class="mm-row">
          <label>启用视频通话</label>
          <input id="mm_vrm_enabled" type="checkbox">
          <span class="mm-inline-hint">启用后出现视频悬浮球</span>
        </div>
        <div class="mm-row">
          <label>LLM 预设</label>
          <select id="mm_vrm_llm_preset" class="text_pole llm-preset-sel"></select>
        </div>
        <div class="mm-section-title" style="margin-top:14px">VRM 模型</div>
        <div class="mm-row">
          <label>模型 URL</label>
          <input id="mm_vrm_url" class="text_pole" type="text" placeholder="https://... 或留空使用下方上传">
        </div>
        <div class="mm-row">
          <label>上传模型</label>
          <button id="mm_vrm_upload" class="menu_button"><i class="fa-solid fa-upload"></i> 选择 .vrm 文件</button>
          <span id="mm_vrm_filename" class="mm-inline-hint"></span>
        </div>
        <div class="mm-row" style="flex-wrap:wrap;gap:8px">
          <button id="mm_vrm_preview" class="menu_button"><i class="fa-solid fa-eye"></i> 预览模型</button>
          <button id="mm_vrm_stop_preview" class="menu_button" style="display:none"><i class="fa-solid fa-stop"></i> 停止预览</button>
        </div>
        <div id="mm_vrm_preview_wrap" style="display:none;margin-top:10px;width:100%;text-align:center">
          <canvas id="mm_vrm_preview_canvas" width="320" height="420" style="border-radius:12px;max-width:100%;display:inline-block"></canvas>
        </div>
        <div class="mm-section-title" style="margin-top:14px">画面设置</div>
        <div class="mm-row">
          <label>背景色</label>
          <select id="mm_vrm_bg" class="text_pole">
            <option value="transparent">透明（显示酒馆背景）</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </div>
        <div class="mm-row" style="align-items:center">
          <label>渲染质量</label>
          <input id="mm_vrm_dpr" type="range" min="0.5" max="3" step="0.5" style="flex:1;margin:0 8px">
          <span id="mm_vrm_dpr_val" class="mm-inline-hint" style="min-width:28px;text-align:right">1×</span>
        </div>
        <p class="mm-desc" style="margin-top:2px">手机建议 1×，PC 建议 1.5~2×。</p>
      </div>

    </div>
  </div>
</div>`;
        document.body.insertAdjacentHTML('beforeend', panelHtml);

        // ── Tab 切换 ──
        document.querySelectorAll('#mm-config-dialog .mm-tab').forEach(tab => {
            tab.addEventListener('click', function() {
                const t = this.dataset.tab;
                document.querySelectorAll('#mm-config-dialog .mm-tab').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                document.querySelectorAll('#mm-config-dialog .mm-tab-panel').forEach(p => p.classList.remove('active'));
                document.querySelector(`#mm-config-dialog .mm-tab-panel[data-panel="${t}"]`).classList.add('active');
                if (t === 'vc')     { renderVcBlocks(); }
                if (t === 'tts')    { renderVoiceLibrary(); refreshVoiceSelects(); renderBindings(); }
                if (t === 'format') { renderRules(); renderRegexPresets(); renderPreProcessRules(); }
                if (t === 'vrm')    { syncVrmFields(); }
            });
        });

        // ── 关闭 ──
        document.getElementById('mm-config-mask').addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('mm-config-open');
        });
        document.querySelector('#mm-config-dialog .mm-config-close').addEventListener('click', () => {
            document.getElementById('mm-config-mask').classList.remove('mm-config-open');
        });

        // ── TTS 基础 ──
        const syncTts = () => {
            const voiceSel = document.getElementById('mm_voice_sel');
            s().apiKey  = document.getElementById('mm_key').value;
            s().groupId = document.getElementById('mm_gid').value;
            s().apiHost = document.getElementById('mm_apihost').value;
            s().model   = document.getElementById('mm_model').value;
            s().voiceId = voiceSel.value || document.getElementById('mm_voice').value;
            s().speed   = Number(document.getElementById('mm_speed').value);
            s().vol     = Number(document.getElementById('mm_vol').value);
            s().ttsLanguage = document.getElementById('mm_tts_lang').value;
            s().autoPlay = document.getElementById('mm_autoplay').checked;
            saveSettingsDebounced();
            syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());
        };
        document.getElementById('mm_show_bubbles').addEventListener('change', function() {
            s().showBubbles = this.checked;
            saveSettingsDebounced();
            if (this.checked) refreshAllBubbles(); else removeAllBubbles();
        });
        ['mm_key','mm_gid','mm_apihost','mm_model','mm_voice_sel','mm_voice','mm_speed','mm_vol','mm_tts_lang','mm_autoplay'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return; // ★ 防御 null
            el.addEventListener('input', syncTts);
            el.addEventListener('change', syncTts);
        });
        document.getElementById('mm_voice_sel').addEventListener('change', function() {
            document.getElementById('mm_voice').style.display = this.value ? 'none' : '';
        });
        const TEST_TEXTS = {
            '':   '你好，我是MiniMax语音。',
            'zh': '你好，我是MiniMax语音。',
            'en': 'Hello, I am MiniMax voice.',
            'ja': 'こんにちは、MiniMaxの音声です。',
            'ko': '안녕하세요, 저는 MiniMax 음성입니다.',
            'fr': 'Bonjour, je suis la voix MiniMax.',
            'de': 'Hallo, ich bin die MiniMax-Stimme.',
            'es': 'Hola, soy la voz MiniMax.',
            'pt': 'Olá, sou a voz MiniMax.',
            'id': 'Halo, saya adalah suara MiniMax.',
            'ar': 'مرحبًا، أنا صوت MiniMax.',
        };
        document.getElementById('mm_test_tts').addEventListener('click', async () => {
            try {
                const lang = s().ttsLanguage || '';
                const text = TEST_TEXTS[lang] || TEST_TEXTS[''];
                const item = { text, options: buildSynthesisOptions(null, null), serverPath: null };
                const blob = await getAudioBlob(item);
                new Audio(URL.createObjectURL(blob)).play();
                toastr.success('语音连通成功！');
            } catch(e) { toastr.error('语音测试失败: ' + e.message); }
        });
        document.getElementById('mm_add_voice').addEventListener('click', () => {
            if (!s().voiceLibrary) s().voiceLibrary = [];
            s().voiceLibrary.push({ name: '', voiceId: '' });
            renderVoiceLibrary(); saveSettingsDebounced();
        });

        // ── 角色绑定 ──
        document.getElementById('mm_add_b').addEventListener('click', () => {
            const c = getContext(), id = c.characterId || c.character_id || c.name2 || 'global';
            if (!s().characterBindingsMap[id]) s().characterBindingsMap[id] = [];
            s().characterBindingsMap[id].push({ targetType: TARGET_TYPE.CUSTOM, customName: '', voiceId: '', model: s().model });
            renderBindings(); saveSettingsDebounced();
        });

        // ── 文本规则 ──
        document.getElementById('mm_add_rule').addEventListener('click', () => {
            if (!s().regexRules) s().regexRules = [];
            s().regexRules.push({ id: 'rule-' + Date.now(), enabled: true, name: '新规则', pattern: '', flags: 'g', mode: 'extract' });
            renderRules(); saveSettingsDebounced();
        });
        document.getElementById('mm_add_pre_rule').addEventListener('click', () => {
            if (!s().llmPreProcessRules) s().llmPreProcessRules = [];
            s().llmPreProcessRules.push({ id: 'pre-' + Date.now(), enabled: true, name: '新规则', pattern: '', mode: 'exclude' });
            renderPreProcessRules(); saveSettingsDebounced();
        });
        document.getElementById('mm_regex_save_p').addEventListener('click', () => {
            const name = prompt('预设名称：'); if (!name) return;
            if (!s().regexPresets) s().regexPresets = [];
            s().regexPresets.push({ name, rules: JSON.parse(JSON.stringify(s().regexRules || [])) });
            renderRegexPresets(); saveSettingsDebounced(); toastr.success('预设已保存');
        });
        document.getElementById('mm_regex_upd_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_regex_presets').value);
            if (i < 0 || !s().regexPresets?.[i]) return;
            s().regexPresets[i].rules = JSON.parse(JSON.stringify(s().regexRules || []));
            saveSettingsDebounced(); toastr.success('预设已更新');
        });
        document.getElementById('mm_regex_presets').addEventListener('change', function() {
            const i = Number(this.value);
            if (i < 0 || !s().regexPresets?.[i]) return;
            s().regexRules = JSON.parse(JSON.stringify(s().regexPresets[i].rules));
            renderRules(); saveSettingsDebounced();
        });
        document.getElementById('mm_regex_del_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_regex_presets').value);
            if (i < 0 || !s().regexPresets?.[i]) return;
            s().regexPresets.splice(i, 1); renderRegexPresets(); saveSettingsDebounced();
        });
        document.getElementById('mm_regex_export').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().regexPresets || [], null, 2)], {type:'application/json'}));
            a.download = 'regex_presets.json'; a.click();
        });
        document.getElementById('mm_regex_import').addEventListener('click', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async () => {
                try {
                    const data = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(data)) {
                        if (!s().regexPresets) s().regexPresets = [];
                        s().regexPresets.push(...data);
                        renderRegexPresets(); saveSettingsDebounced();
                        toastr.success(`已导入 ${data.length} 个预设`);
                    }
                } catch(e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });

        // ── 副LLM格式化 ──
        const syncFormatter = () => {
            s().formatterEnabled   = document.getElementById('mm_f_en').checked;
            s().formatterPresetIdx = Number(document.getElementById('mm_f_preset_sel').value);
            s().formatterSystemPrompt = document.getElementById('mm_f_prompt').value;
            saveSettingsDebounced();
        };
        const selFT = document.getElementById('mm_f_templates');
        const upFTemplates = () => {
            selFT.innerHTML = '<option value="-1">-- 新建模板 --</option>';
            (s().formatterTemplates || []).forEach((t, i) => {
                const o = document.createElement('option'); o.value = i; o.textContent = t.name; selFT.appendChild(o);
            });
        };
        ['mm_f_en','mm_f_preset_sel','mm_f_prompt'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', syncFormatter);
            el.addEventListener('change', syncFormatter);
        });
        selFT.addEventListener('change', function() {
            const t = (s().formatterTemplates||[])[Number(this.value)];
            if (t) { document.getElementById('mm_f_prompt').value = t.content; syncFormatter(); }
        });
        document.getElementById('mm_f_save_t').addEventListener('click', () => {
            const n = prompt('模板名:'); if (!n) return;
            if (!s().formatterTemplates) s().formatterTemplates = [];
            s().formatterTemplates.push({ name: n, content: document.getElementById('mm_f_prompt').value });
            upFTemplates(); saveSettingsDebounced();
        });
        document.getElementById('mm_f_upd_t').addEventListener('click', () => {
            const i = Number(selFT.value); if (i >= 0) { (s().formatterTemplates||[])[i].content = document.getElementById('mm_f_prompt').value; toastr.success('更新成功'); saveSettingsDebounced(); }
        });
        document.getElementById('mm_f_del_t').addEventListener('click', () => {
            const i = Number(selFT.value); if (i >= 0) { (s().formatterTemplates||[]).splice(i, 1); upFTemplates(); saveSettingsDebounced(); }
        });
        document.getElementById('mm_f_export_t').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().formatterTemplates || [], null, 2)], {type:'application/json'}));
            a.download = 'formatter_templates.json'; a.click();
        });
        document.getElementById('mm_f_import_t').addEventListener('click', () => {
            const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async () => {
                try {
                    const data = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(data)) { if (!s().formatterTemplates) s().formatterTemplates = []; s().formatterTemplates.push(...data); upFTemplates(); saveSettingsDebounced(); toastr.success(`已导入 ${data.length} 个模板`); }
                } catch(e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });

        // ── LLM 预设 CRUD ──
        document.getElementById('mm_llm_presets').addEventListener('change', function() { loadLlmPresetFieldsGlobal(Number(this.value)); });
        document.getElementById('mm_llm_save_p').addEventListener('click', () => {
            const n = prompt('预设名:'); if (!n) return;
            const modelSel = document.getElementById('mm_llm_model_sel');
            const model = modelSel.style.display !== 'none' ? modelSel.value : document.getElementById('mm_llm_model').value;
            s().llmPresets.push({ name: n, url: document.getElementById('mm_llm_url').value, key: document.getElementById('mm_llm_key').value, format: document.getElementById('mm_llm_format').value, model });
            const newIdx = s().llmPresets.length - 1;
            refreshAllLlmPresetSelects(); document.getElementById('mm_llm_presets').value = newIdx;
            saveSettingsDebounced(); toastr.success('预设已保存');
        });
        document.getElementById('mm_llm_upd_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_llm_presets').value);
            if (i < 0 || i >= s().llmPresets.length) return;
            const modelSel = document.getElementById('mm_llm_model_sel');
            const model = modelSel.style.display !== 'none' ? modelSel.value : document.getElementById('mm_llm_model').value;
            s().llmPresets[i] = { ...s().llmPresets[i], url: document.getElementById('mm_llm_url').value, key: document.getElementById('mm_llm_key').value, format: document.getElementById('mm_llm_format').value, model };
            refreshAllLlmPresetSelects(); document.getElementById('mm_llm_presets').value = i;
            saveSettingsDebounced(); toastr.success('预设已更新');
        });
        document.getElementById('mm_llm_del_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_llm_presets').value);
            if (i < 0 || i >= s().llmPresets.length) return;
            s().llmPresets.splice(i, 1);
            if (s().formatterPresetIdx >= s().llmPresets.length) s().formatterPresetIdx = s().llmPresets.length - 1;
            if (s().vcLlmPresetIdx >= s().llmPresets.length) s().vcLlmPresetIdx = s().llmPresets.length - 1;
            refreshAllLlmPresetSelects();
            const newI = Number(document.getElementById('mm_llm_presets').value);
            if (newI >= 0) loadLlmPresetFieldsGlobal(newI);
            else {
                ['mm_llm_url','mm_llm_key','mm_llm_model'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('mm_llm_format').value = API_FORMATS.OAI;
                document.getElementById('mm_llm_model').style.display     = '';
                document.getElementById('mm_llm_model_sel').style.display = 'none';
            }
            saveSettingsDebounced();
        });
        document.getElementById('mm_llm_fetch').addEventListener('click', async () => {
            const url    = document.getElementById('mm_llm_url').value.trim().replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
            const key    = document.getElementById('mm_llm_key').value.trim();
            const format = document.getElementById('mm_llm_format').value;
            try {
                let m = [];
                if (format === API_FORMATS.OAI) { const d = await proxyFetch(`${url}/models`, { headers: key ? { 'Authorization': `Bearer ${key}` } : {} }); m = d.data?.map(it => typeof it === 'string' ? it : it.id) || []; }
                else { const d = await proxyFetch(`${url}/v1beta/models`, { headers: key ? { 'x-goog-api-key': key } : {} }); m = d.models?.map(it => it.name.replace('models/', '')) || []; }
                if (m.length) {
                    const sel = document.getElementById('mm_llm_model_sel');
                    sel.innerHTML = ''; sel.style.display = '';
                    document.getElementById('mm_llm_model').style.display = 'none';
                    m.forEach(it => { const o = document.createElement('option'); o.value = it; o.textContent = it; sel.appendChild(o); });
                    sel.value = m[0]; toastr.success('获取成功');
                }
            } catch(e) { toastr.error(e.message); }
        });
        document.getElementById('mm_llm_test_conn').addEventListener('click', async () => {
            const url    = document.getElementById('mm_llm_url').value.trim();
            const key    = document.getElementById('mm_llm_key').value.trim();
            const format = document.getElementById('mm_llm_format').value;
            const modelSel = document.getElementById('mm_llm_model_sel');
            const model = modelSel.style.display !== 'none' ? modelSel.value : document.getElementById('mm_llm_model').value;
            try {
                let d;
                if (format === API_FORMATS.OAI) {
                    d = await proxyFetch(normalizeOaiUrl(url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Authorization': `Bearer ${key}` } : {}) }, body: { model, messages: [{ role: 'user', content: 'Say connected' }], temperature: 0.1 } });
                } else {
                    const gUrl = `${url.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`;
                    d = await proxyFetch(gUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) }, body: { contents: [{ role: 'user', parts: [{ text: 'Say connected' }] }] } });
                }
                if (d) toastr.success('API 连通成功！');
            } catch(e) { toastr.error(e.message); }
        });

        // ── 语音通话 ──
        const syncVc = () => {
            const enabled = document.getElementById('mm_vc_enabled').checked;
            s().vcEnabled      = enabled;
            s().vcLlmPresetIdx = Number(document.getElementById('mm_vc_llm_preset').value);
            s().vcInjectOnEnd  = document.getElementById('mm_vc_inject').checked;
            saveSettingsDebounced();
            const fab = document.getElementById('vc-fab');
            if (fab) fab.style.display = enabled ? '' : 'none';
        };
        ['mm_vc_enabled','mm_vc_llm_preset','mm_vc_inject'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', syncVc);
            el.addEventListener('change', syncVc);
        });

        // ── 视频通话 (VRM) ──
        function syncVrmFields() {
            document.getElementById('mm_vrm_enabled').checked = !!s().vrmEnabled;
            let url = s().vrmModelUrl || '';
            if (url.startsWith('//')) { url = url.slice(1); s().vrmModelUrl = url; saveSettingsDebounced(); }
            const isUpload = url.startsWith('blob:') || url.startsWith('/user/files/') || url.startsWith('user/files/');
            document.getElementById('mm_vrm_url').value = isUpload ? '' : url;
            document.getElementById('mm_vrm_filename').textContent = isUpload ? (s().vrmFilename || '（已上传）') : '';
            document.getElementById('mm_vrm_bg').value = s().vrmBg || 'transparent';
            const dpr = s().vrmPixelRatio ?? 1;
            const dprEl = document.getElementById('mm_vrm_dpr');
            if (dprEl) { dprEl.value = dpr; document.getElementById('mm_vrm_dpr_val').textContent = dpr + '×'; }
            refreshAllLlmPresetSelects();
            if (s().vrmLlmPresetIdx >= 0) document.getElementById('mm_vrm_llm_preset').value = s().vrmLlmPresetIdx;
        }
        document.getElementById('mm_vrm_enabled').addEventListener('change', function() {
            s().vrmEnabled = this.checked; saveSettingsDebounced();
            const vrmFab = document.getElementById('vrm-fab');
            if (vrmFab) vrmFab.style.display = this.checked ? '' : 'none';
        });
        document.getElementById('mm_vrm_llm_preset').addEventListener('change', function() {
            s().vrmLlmPresetIdx = Number(this.value); saveSettingsDebounced();
        });
        document.getElementById('mm_vrm_url').addEventListener('input', function() {
            s().vrmModelUrl = this.value.trim(); saveSettingsDebounced();
        });
        document.getElementById('mm_vrm_bg').addEventListener('change', function() {
            s().vrmBg = this.value; saveSettingsDebounced();
            applyVrmBg();
        });
        document.getElementById('mm_vrm_dpr').addEventListener('input', function() {
            const dpr = Number(this.value);
            s().vrmPixelRatio = dpr; saveSettingsDebounced();
            document.getElementById('mm_vrm_dpr_val').textContent = dpr + '×';
            if (vrmModule?.isReady()) vrmModule.setPixelRatio(dpr);
        });
        document.getElementById('mm_vrm_upload').addEventListener('click', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.vrm';
            inp.onchange = async () => {
                const file = inp.files?.[0]; if (!file) return;
                const btn = document.getElementById('mm_vrm_upload');
                const origHtml = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 上传中...';
                btn.disabled = true;
                try {
                    const serverPath = await vrmServerUpload(file);
                    s().vrmModelUrl = serverPath;
                    s().vrmFilename = file.name;
                    saveSettingsDebounced();
                    document.getElementById('mm_vrm_url').value = '';
                    document.getElementById('mm_vrm_filename').textContent = file.name;
                    toastr.success('VRM 已上传到服务器');
                    document.getElementById('mm_vrm_preview').click();
                } catch (e) {
                    toastr.error('VRM 上传失败: ' + e.message);
                } finally {
                    btn.innerHTML = origHtml;
                    btn.disabled = false;
                }
            };
            inp.click();
        });
        document.getElementById('mm_vrm_preview').addEventListener('click', async () => {
            const url = s().vrmModelUrl?.trim();
            if (!url) { toastr.warning('请先填写模型 URL 或上传 .vrm 文件'); return; }
            const wrap = document.getElementById('mm_vrm_preview_wrap');
            wrap.style.display = '';
            document.getElementById('mm_vrm_stop_preview').style.display = '';
            const canvas = document.getElementById('mm_vrm_preview_canvas');
            try {
                if (!vrmModule) vrmModule = await import('./vrm.js');
                await vrmModule.init(canvas, s().vrmPixelRatio ?? 1);
                await vrmModule.loadModel(url);
                vrmModule.setState('idle');
                toastr.success('VRM 模型加载成功');
            } catch (e) {
                console.error('[VRM] 加载失败:', e);
                toastr.error('VRM 加载失败: ' + e.message, '', { timeOut: 8000 });
                wrap.style.display = 'none';
                document.getElementById('mm_vrm_stop_preview').style.display = 'none';
            }
        });
        document.getElementById('mm_vrm_stop_preview').addEventListener('click', () => {
            if (vrmModule) { try { vrmModule.destroy(); } catch (_) {} }
            document.getElementById('mm_vrm_preview_wrap').style.display = 'none';
            document.getElementById('mm_vrm_stop_preview').style.display = 'none';
        });

        // VC 提示词模板
        const vcTplSel = document.getElementById('mm_vc_templates');
        const upVcTemplates = () => {
            vcTplSel.innerHTML = '<option value="-1">-- 新建模板 --</option>';
            (s().vcPromptTemplates || []).forEach((t, i) => {
                const o = document.createElement('option'); o.value = i; o.textContent = t.name; vcTplSel.appendChild(o);
            });
        };
        vcTplSel.addEventListener('change', function() {
            const t = (s().vcPromptTemplates||[])[Number(this.value)];
            if (t) { s().vcPromptBlocks = JSON.parse(JSON.stringify(t.blocks)); if (t.systemPrompt !== undefined) s().vcSystemPrompt = t.systemPrompt; renderVcBlocks(); saveSettingsDebounced(); }
        });
        document.getElementById('mm_vc_save_t').addEventListener('click', () => {
            const n = prompt('模板名:'); if (!n) return;
            if (!s().vcPromptTemplates) s().vcPromptTemplates = [];
            s().vcPromptTemplates.push({ name: n, blocks: JSON.parse(JSON.stringify(s().vcPromptBlocks||getDefaultVcBlocks())), systemPrompt: s().vcSystemPrompt||'' });
            upVcTemplates(); saveSettingsDebounced();
        });
        document.getElementById('mm_vc_upd_t').addEventListener('click', () => {
            const i = Number(vcTplSel.value); if (i >= 0) { const tpls = s().vcPromptTemplates||[]; tpls[i].blocks = JSON.parse(JSON.stringify(s().vcPromptBlocks||getDefaultVcBlocks())); tpls[i].systemPrompt = s().vcSystemPrompt||''; toastr.success('更新成功'); saveSettingsDebounced(); }
        });
        document.getElementById('mm_vc_del_t').addEventListener('click', () => {
            const i = Number(vcTplSel.value); if (i >= 0) { (s().vcPromptTemplates||[]).splice(i, 1); upVcTemplates(); saveSettingsDebounced(); }
        });
        document.getElementById('mm_vc_export_t').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().vcPromptTemplates || [], null, 2)], {type:'application/json'}));
            a.download = 'vc_prompt_templates.json'; a.click();
        });
        document.getElementById('mm_vc_import_t').addEventListener('click', () => {
            const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async () => {
                try {
                    const data = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(data)) { if (!s().vcPromptTemplates) s().vcPromptTemplates = []; s().vcPromptTemplates.push(...data); upVcTemplates(); saveSettingsDebounced(); toastr.success(`已导入 ${data.length} 个模板`); }
                } catch(e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });
        document.getElementById('mm_vc_ctx_count').addEventListener('input', function() {
            s().vcContextCount = Number(this.value) || 10; saveSettingsDebounced();
        });
        document.getElementById('mm_vc_add_block').addEventListener('click', () => {
            if (!s().vcPromptBlocks) s().vcPromptBlocks = getDefaultVcBlocks();
            s().vcPromptBlocks.push({ id: 'custom-' + Date.now(), enabled: true, label: '自定义块', editable: true, content: '', hint: '' });
            saveSettingsDebounced(); renderVcBlocks();
        });

        upFTemplates();
        upVcTemplates();
    }

    // ★ 修复7: 每次打开都刷新字段值
    populateConfigFields();
    document.getElementById('mm-config-mask').classList.add('mm-config-open');
}

jQuery(async () => {
    loadSettings(); createUi();
    let timer, longP;

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (id) => {
        const ctx = getContext();
        if (ctx.chat?.[id]?.extra?.voice_call) return;
        if (s().enabled && s().autoPlay && !vcActive) {
            if (await generateMessageSpeech(id, false)) {
                playGeneratedMessage(id);
            }
        } else {
            extractSegmentsOnly(id);
        }
        injectBubbles(id);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(refreshAllBubbles, 600);
    });

    $(document).on('mousedown touchstart', '.mes_quote_tts', function(){
        const id = Number($(this).closest('.mes').attr('mesid')); longP=false;
        timer = setTimeout(async () => {
            longP = true;
            if (s().formatterEnabled) {
                toastr.info('生成结构中...');
                if (await generateMessageSpeech(id, true)) toastr.success('生成成功！点击图标播放。');
            } else { if (await generateMessageSpeech(id, true)) playGeneratedMessage(id); }
        }, 600);
    }).on('mouseup mouseleave touchend touchcancel', '.mes_quote_tts', () => clearTimeout(timer));

    $(document).on('click', '.mes_quote_tts', function(e){
        if(longP) return;
        if(clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(async () => {
            clickTimer = null;
            const id = Number($(e.target).closest('.mes').attr('mesid')), { key } = getMessageData(id);
            if (s().formatterEnabled) {
                if (!s().serverHistory[key] || !s().serverHistory[key].versions.length) return toastr.warning('请先长按。');
                playGeneratedMessage(id);
            } else { if (await generateMessageSpeech(id)) playGeneratedMessage(id); }
        }, 250);
    }).on('dblclick', '.mes_quote_tts', function(e){
        e.preventDefault(); if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openParamsEditor(Number($(this).closest('.mes').attr('mesid')));
    });
    setInterval(() => { refreshAllMessageButtons(); refreshAllBubbles(); }, 1000);

    $(document).on('click', '.mm-bubble', async function() {
        if ($(this).hasClass('mm-bubble-loading') || $(this).hasClass('mm-bubble-playing')) return;
        const mesid = Number($(this).data('mesid'));
        const segidx = Number($(this).data('segidx'));
        const { key } = getMessageData(mesid);
        const h = s().serverHistory[key];
        const item = h?.versions?.[h.activeIndex]?.items?.[segidx];
        if (!item) return;
        const $b = $(this);
        $b.addClass('mm-bubble-loading');
        try {
            const blob = await getAudioBlob(item);
            $b.removeClass('mm-bubble-loading').addClass('mm-bubble-playing');
            refreshBubbleStates(mesid);
            refreshAllMessageButtons();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.onended  = () => { URL.revokeObjectURL(url); $b.removeClass('mm-bubble-playing'); };
            audio.onerror  = () => { URL.revokeObjectURL(url); $b.removeClass('mm-bubble-playing'); };
            await audio.play();
        } catch(e) {
            $b.removeClass('mm-bubble-loading mm-bubble-playing');
            toastr.error('播放失败: ' + e.message);
        }
    });
});


// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                        VOICE CALL MODULE                                  ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

const VC_DEFAULTS = {
    vcEnabled: true,
    sttLang: '',
    vcLlmPresetIdx: -1,
    vcContextCount: 10,
    vcSystemPrompt: '你现在正在与用户进行语音通话。请用自然的口语回答，不要使用任何 Markdown 格式、动作描述（*动作*）或表情符号，只说出可以直接朗读的话语。一次最多回复1-2句话！！',
    vcInjectOnEnd: true,
};

let vcActive   = false;
let vcState    = 'idle';
let callMode   = 'voice';

const VRM_HUD_MAP = { 'vc-status':'vrm-info-status', 'vc-log':'vrm-log', 'vc-name':'vrm-info-name', 'vc-timer':'vrm-info-timer', 'vc-mute':'vrm-mute', 'vc-canvas': null };
function vcEl(id) {
    if (callMode === 'video') {
        const mapped = VRM_HUD_MAP[id];
        if (mapped === null) return null;
        if (mapped !== undefined) return document.getElementById(mapped);
    }
    return document.getElementById(id);
}

let vcAudioCtx    = null;
let vcPlaybackCtx = null;
let vcStream      = null;
let vcAnalyser    = null;
let vcRafId       = null;
let vcMuted       = false;
let vcSpeakAudio  = null;
let vcTimerInterval = null;
let vcSpeechRec   = null;
let vcStartTime   = null;
let vcStreamBuffer  = '';
let vcTtsPipeline   = [];
let vcTtsDraining   = false;
let vcGenDone       = true;
let vcCallLog       = [];
let vcLlmAbortCtrl  = null;
let vcCurrentResponseAudioItems = null;

let vrmModule      = null;
let vrmAnalyserNode = null;

function applyVrmBg() {
    const frame = document.getElementById('mm-vrm-frame');
    if (!frame) return;
    const bg = s().vrmBg || 'transparent';
    const map = { transparent: 'transparent', dark: '#09111f', light: '#f0eff5' };
    frame.style.background = map[bg] ?? 'transparent';
}

const VRM_DB_NAME  = 'mm-vrm-db';
const VRM_DB_STORE = 'files';
const VRM_DB_KEY   = 'vrm-model';

function vrmOpenDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(VRM_DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(VRM_DB_STORE);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

async function vrmDbSave(file) {
    try {
        const db = await vrmOpenDb();
        await new Promise((resolve, reject) => {
            const tx  = db.transaction(VRM_DB_STORE, 'readwrite');
            const req = tx.objectStore(VRM_DB_STORE).put(file, VRM_DB_KEY);
            req.onsuccess = resolve; req.onerror = e => reject(e.target.error);
        });
        db.close();
    } catch (e) { console.warn('[VRM] IndexedDB save failed', e); }
}

async function vrmDbLoad() {
    try {
        const db = await vrmOpenDb();
        const file = await new Promise((resolve, reject) => {
            const tx  = db.transaction(VRM_DB_STORE, 'readonly');
            const req = tx.objectStore(VRM_DB_STORE).get(VRM_DB_KEY);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
        db.close();
        return file || null;
    } catch (e) { console.warn('[VRM] IndexedDB load failed', e); return null; }
}

async function vrmServerUpload(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const base64   = reader.result.split(',')[1];
                const safeName = file.name.replace(/[^a-zA-Z0-9_\-.]/g, '_');
                const res = await fetch('/api/files/upload', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ name: safeName, data: base64 }),
                });
                if (!res.ok) {
                    const msg = await res.text();
                    reject(new Error(msg || res.statusText));
                    return;
                }
                const json = await res.json();
                const serverPath = json.path.startsWith('/') ? json.path : '/' + json.path;
                resolve(serverPath);
            } catch (e) { reject(e); }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

async function restoreVrmBlobUrl() {
    const stored = s().vrmModelUrl || '';
    if (!stored || !stored.startsWith('blob:')) return;
    const file = await vrmDbLoad();
    if (file) {
        try {
            const serverPath = await vrmServerUpload(file);
            s().vrmModelUrl  = serverPath;
            saveSettingsDebounced();
        } catch {
            s().vrmModelUrl = URL.createObjectURL(file);
        }
    } else {
        s().vrmModelUrl = '';
        saveSettingsDebounced();
    }
}

function vcLoadSettings() {
    const set = extension_settings[MODULE_NAME];
    for (const k in VC_DEFAULTS) {
        if (set[k] === undefined) set[k] = VC_DEFAULTS[k];
    }
}
function vc() { return extension_settings[MODULE_NAME]; }

function vcSetState(state) {
    vcState  = state;
    vcActive = state !== 'idle';

    const icons = {
        idle: 'fa-phone', connecting: 'fa-spinner fa-spin',
        listening: 'fa-microphone', recording: 'fa-circle',
        processing: 'fa-spinner fa-spin', thinking: 'fa-spinner fa-spin',
        speaking: 'fa-volume-high',
    };
    const labels = {
        idle: '', connecting: '正在接通...',
        listening: '聆听中', recording: '录音中...',
        processing: '识别中...', thinking: 'AI 思考中...',
        speaking: 'AI 说话中...',
    };

    const fab    = document.getElementById('vc-fab');
    const vrmFab = document.getElementById('vrm-fab');
    if (state === 'idle') {
        if (fab)    { fab.querySelector('i').className = 'fa-solid fa-phone';  fab.classList.remove('vc-fab-active'); fab.style.opacity = ''; fab.style.pointerEvents = ''; }
        if (vrmFab) { vrmFab.querySelector('i').className = 'fa-solid fa-video'; vrmFab.classList.remove('vc-fab-active'); vrmFab.style.opacity = ''; vrmFab.style.pointerEvents = ''; }
    } else if (callMode === 'voice') {
        if (fab)    { fab.querySelector('i').className = `fa-solid ${icons[state] || 'fa-phone'}`; fab.classList.add('vc-fab-active'); fab.style.opacity = ''; fab.style.pointerEvents = ''; }
        if (vrmFab) { vrmFab.style.opacity = '0.35'; vrmFab.style.pointerEvents = 'none'; }
    } else {
        if (vrmFab) { vrmFab.querySelector('i').className = `fa-solid ${icons[state] || 'fa-video'}`; vrmFab.classList.add('vc-fab-active'); vrmFab.style.opacity = ''; vrmFab.style.pointerEvents = ''; }
        if (fab)    { fab.style.opacity = '0.35'; fab.style.pointerEvents = 'none'; }
    }
    const statusEl = vcEl('vc-status');
    if (statusEl) statusEl.textContent = (vcMuted && state === 'listening') ? '已静音' : (labels[state] ?? '');
    const dialog = document.getElementById('vc-dialog');
    if (dialog) dialog.dataset.state = state;

    if (vrmModule?.isReady?.()) {
        const VRM_STATE_MAP = {
            idle: 'idle', connecting: 'idle',
            listening: 'listening', recording: 'listening',
            processing: 'thinking', thinking: 'thinking',
            speaking: 'speaking',
        };
        vrmModule.setState(VRM_STATE_MAP[state] || 'idle');
    }
}

function vcExtractSentences(text) {
    const complete = [];
    let lastIdx = 0;

    const termRe = /[^。！？!?\n]*[。！？!?\n]+/g;
    let m;
    while ((m = termRe.exec(text)) !== null) {
        const s = m[0].replace(/\s+/g, ' ').trim();
        if (s.length >= 1) complete.push(s);
        lastIdx = termRe.lastIndex;
    }

    const MIN_BEFORE = 3;
    const rest = text.slice(lastIdx);
    const SOFT_SEPS = ['\u3001', '\uff0c', '\uff1b', ',', ';'];
    let bestSoftIdx = Infinity;
    for (const sep of SOFT_SEPS) {
        let idx = rest.indexOf(sep);
        while (idx !== -1 && idx < MIN_BEFORE) idx = rest.indexOf(sep, idx + 1);
        if (idx !== -1 && idx < bestSoftIdx) bestSoftIdx = idx;
    }
    if (bestSoftIdx !== Infinity) {
        const s = rest.slice(0, bestSoftIdx + 1).replace(/\s+/g, ' ').trim();
        if (s.length >= MIN_BEFORE) { complete.push(s); lastIdx += bestSoftIdx + 1; }
    }

    return { complete, rest: text.slice(lastIdx) };
}

function vcGetTtsOptions() {
    const set = s(), ctx = getContext();
    const charId   = ctx.characterId ?? ctx.character_id ?? ctx.name2 ?? 'global';
    const bindings = set.characterBindingsMap?.[charId] || [];
    const charName = (ctx.name2 || '').toLowerCase();
    const binding  = bindings.find(b => {
        const n = (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 :
                   b.targetType === TARGET_TYPE.CURRENT_USER      ? ctx.name1 : b.customName)?.toLowerCase();
        return n === charName;
    });
    return {
        model:       binding?.model   || set.model,
        voiceId:     binding?.voiceId || set.voiceId,
        speed:       Number(set.speed),
        vol:         Number(set.vol),
        pitch:       Number(set.pitch),
        audioFormat: 'mp3',
        emotion:     set.emotion || '',
    };
}

function vcEnqueueTts(text) {
    if (!text || !vcActive) return;
    const p = vcTtsSpeak(text).catch(() => null);
    vcTtsPipeline.push(p);
    if (vcCurrentResponseAudioItems !== null) {
        vcCurrentResponseAudioItems.push({ text, options: vcGetTtsOptions(), blob: p });
    }
    if (!vcTtsDraining) vcDrainTtsPipeline();
}

async function vcDrainTtsPipeline() {
    if (vcTtsDraining) return;
    vcTtsDraining = true;
    let drainIdx = 0;
    while (vcTtsPipeline.length > 0) {
        drainIdx++;
        const blob = await vcTtsPipeline.shift();
        if (!vcActive) break;
        if (!blob) continue;
        if (vcState === 'thinking') vcSetState('speaking');
        if (vcPlaybackCtx) {
            try {
                const arrayBuffer = await blob.arrayBuffer();
                const audioBuffer = await vcPlaybackCtx.decodeAudioData(arrayBuffer);
                const source = vcPlaybackCtx.createBufferSource();
                source.buffer = audioBuffer;
                if (vrmAnalyserNode) {
                    source.connect(vrmAnalyserNode);
                    vrmAnalyserNode.connect(vcPlaybackCtx.destination);
                } else {
                    source.connect(vcPlaybackCtx.destination);
                }
                vcSpeakAudio = source;
                await new Promise(resolve => {
                    source.onended = () => { vcSpeakAudio = null; resolve(); };
                    source.start();
                });
            } catch (e) {
                vcSpeakAudio = null;
            }
        } else {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            vcSpeakAudio = audio;
            await new Promise(resolve => {
                audio.onended = () => { URL.revokeObjectURL(url); vcSpeakAudio = null; resolve(); };
                audio.onerror = () => { URL.revokeObjectURL(url); vcSpeakAudio = null; resolve(); };
                audio.play().catch(resolve);
            });
        }
        if (!vcActive) break;
    }
    vcTtsDraining = false;
    if (vcActive && vcGenDone && vcTtsPipeline.length === 0) {
        vcSetState('listening');
        vcResumeListening();
    }
}

async function vcBuildLlmMessages(userText) {
    const set = vc(), ctx = getContext();
    const msgs = [];
    const blocks = (set.vcPromptBlocks || getDefaultVcBlocks()).filter(b => b.enabled);

    for (const block of blocks) {
        if (block.id === 'charDesc') {
            const desc = ctx.characters?.[ctx.characterId]?.description || '';
            if (desc) msgs.push({ role: 'system', content: desc });
        } else if (block.id === 'worldBook') {
            const selectedKeys = block.selectedEntries;
            if (selectedKeys?.length) {
                const allEntries = await loadAllWbEntries();
                const filtered = allEntries.filter(e => selectedKeys.includes(e.key));
                const content = filtered.map(e => e.content).join('\n\n').trim();
                if (content) msgs.push({ role: 'system', content });
            } else {
                const wi = [ctx.worldInfoBefore, ctx.worldInfoAfter].filter(Boolean).join('\n\n').trim();
                if (wi) msgs.push({ role: 'system', content: wi });
            }
        } else if (block.id === 'vcSystem') {
            if (set.vcSystemPrompt) msgs.push({ role: 'system', content: set.vcSystemPrompt });
        } else if (block.id === 'vrmActions') {
            msgs.push({ role: 'system', content: `【表情动作标签】回复中可用以下标签自然表达情绪和动作，系统会自动处理，请勿读出标签文字：\n表情：[e:happy]开心 [e:sad]悲伤 [e:angry]愤怒 [e:surprised]惊讶 [e:relaxed]放松\n动作：[a:nod]点头 [a:shake]摇头 [a:wave]招手 [a:tilt]歪头\n示例："你来了！[e:happy][a:wave] 好久不见。"` });
        } else if (block.id === 'context') {
            const n = Math.max(0, Number(set.vcContextCount) || 10);
            const recent = (ctx.chat || []).filter(m => !m.is_system).slice(-n);
            for (const m of recent) msgs.push({ role: m.is_user ? 'user' : 'assistant', content: applyPreProcessRules(m.mes) });
        } else if (block.editable && block.content) {
            msgs.push({ role: 'system', content: block.content });
        }
    }

    msgs.push(...vcCallLog);
    msgs.push({ role: 'user', content: userText });
    return msgs;
}

const VRM_TAG_RE = /$$(e|a):(\w+)$$/g;
function stripAndDispatchVrmTags(text) {
    let dispatched = 0;
    const stripped = text.replace(VRM_TAG_RE, (_, type, name) => {
        if (callMode === 'video' && vrmModule?.isReady?.()) {
            if (type === 'e') vrmModule.setEmotion(name);
            else if (type === 'a') vrmModule.playAction(name);
            dispatched++;
        }
        return '';
    });
    return { stripped, dispatched };
}

// ★ 修复5: SSE [DONE] 解析——用标志变量跳出外层 while
async function vcStreamingLlm(userText) {
    const presetIdx = (callMode === 'video' && s().vrmLlmPresetIdx >= 0) ? s().vrmLlmPresetIdx : s().vcLlmPresetIdx;
    const preset = (s().llmPresets || [])[presetIdx];
    if (!preset || !preset.url || !preset.model) { toastr.error('请先在设置里选择 LLM 预设'); vcSetState('listening'); vcResumeListening(); return; }
    const url   = normalizeOaiUrl(preset.url);
    const key   = (preset.key || '').trim();
    const model = (preset.model || '').trim();

    vcGenDone = false;
    vcTtsPipeline.length = 0;
    vcStreamBuffer = '';
    vcCurrentResponseAudioItems = [];

    try {
        vcLlmAbortCtrl = new AbortController();
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { 'Authorization': `Bearer ${key}` } : {}) },
            body: JSON.stringify({ model, messages: await vcBuildLlmMessages(userText), stream: true }),
            signal: vcLlmAbortCtrl.signal,
        });
        if (!res.ok) throw new Error(`LLM API HTTP ${res.status}`);

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let sseBuf = '', fullText = '';
        let vrmTagCount = 0;
        let streamDone = false; // ★ 修复5: 标志变量

        const logContainer = vcEl('vc-log');
        let liveLogEl = null;

        try {
            while (!streamDone) { // ★ 修复5: 检查标志
                const { done, value } = await reader.read();
                if (done || !vcActive) break;
                sseBuf += dec.decode(value, { stream: true });
                const lines = sseBuf.split('\n');
                sseBuf = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') { streamDone = true; break; } 
                    try {
                        const delta = JSON.parse(raw).choices?.[0]?.delta?.content || '';
                        if (!delta) continue;
                        fullText += delta;
                        vcStreamBuffer += delta;

                        const { stripped, dispatched } = stripAndDispatchVrmTags(vcStreamBuffer);
                        vcStreamBuffer = stripped;
                        vrmTagCount += dispatched;

                        if (logContainer) {
                            if (!liveLogEl) {
                                liveLogEl = document.createElement('div');
                                liveLogEl.className = 'vc-log-line vc-log-ai';
                                liveLogEl.textContent = 'TA: ';
                                logContainer.appendChild(liveLogEl);
                            }
                            liveLogEl.textContent = 'TA: ' + fullText.replace(/\*[^*]*\*/g, '').replace(VRM_TAG_RE, '').replace(/\n+/g, ' ');
                            logContainer.scrollTop = logContainer.scrollHeight;
                        }

                        const { complete, rest } = vcExtractSentences(vcStreamBuffer);
                        vcStreamBuffer = rest;
                        if (complete.length) {
                            complete.forEach(seg => vcEnqueueTts(seg));
                        }
                    } catch (_) {}
                }
            }
        } finally { reader.releaseLock(); }

        const tail = vcStreamBuffer.trim();
        vcStreamBuffer = '';
        if (tail.length >= 2) vcEnqueueTts(tail);

        if (vcActive && fullText) {
            if (vrmModule?.isReady?.() && vrmTagCount === 0) vrmModule.setEmotionFromText(fullText);
            vcCallLog.push({ role: 'user', content: userText });
            vcCallLog.push({ role: 'assistant', content: fullText, audioItems: vcCurrentResponseAudioItems || [] });
            vcCurrentResponseAudioItems = null;
            if (!liveLogEl) vcLog('ai', fullText.replace(/\*[^*]*\*/g, '').replace(/\n+/g, ' ').trim());
        }
    } catch (e) {
        if (e.name !== 'AbortError') { console.error('[VC LLM]', e); toastr.error('LLM 错误: ' + e.message); }
    }

    vcGenDone = true;
    if (!vcTtsDraining && vcTtsPipeline.length === 0 && vcActive) {
        vcSetState('listening');
        vcResumeListening();
    }
}

async function vcInjectCallRecord(callLog) {
    if (!callLog.length) return;
    const ctx = getContext();
    if (!ctx.chat) return;
    const n1 = ctx.name1 || '你', n2 = ctx.name2 || 'AI';

    const lines = callLog.map(m => `${m.role === 'user' ? n1 : n2}：${m.content}`);
    const transcript = `【语音通话记录】\n${lines.join('\n')}`;

    const newMsg = {
        name: n2, is_user: false, is_system: false,
        send_date: new Date().toLocaleString(),
        mes: transcript, extra: { voice_call: true },
    };
    ctx.chat.push(newMsg);
    const newId = ctx.chat.length - 1;
    addOneMessage(newMsg, { scroll: true, forceId: newId });
    saveChatDebounced();
    toastr.success(`通话记录已注入（${callLog.length / 2 | 0} 轮对话）`);

    const assistantTurns = callLog.filter(m => m.role === 'assistant' && m.audioItems?.length);
    if (!assistantTurns.length) return;

    const TIMEOUT = 5000;
    const VC_TURN_PAUSE_MS = 700;
    const items = [];
    for (let t = 0; t < assistantTurns.length; t++) {
        if (t > 0) items.push({ pauseMs: VC_TURN_PAUSE_MS });
        for (const { text, options, blob: blobP } of assistantTurns[t].audioItems) {
            const blob = await Promise.race([blobP, new Promise(r => setTimeout(() => r(null), TIMEOUT))]);
            if (!blob) continue;
            const cacheKey = `tts_${simpleHash(text)}_${simpleHash(JSON.stringify(options))}`;
            const serverPath = await uploadToSTServer(blob, `${cacheKey}.mp3`);
            items.push({ text, speaker: n2, options, serverPath: serverPath || null });
        }
    }
    if (!items.length) return;

    const { key } = getMessageData(newId);
    if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
    s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
    s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
    saveSettingsDebounced();
    refreshAllMessageButtons();
    if (s().showBubbles) injectBubbles(newId);
}

// ★ 修复4: vcTtsSpeak 也增加直连 fallback
async function vcTtsSpeak(text) {
    const set = s();
    const ctx = getContext();
    const charId  = ctx.characterId ?? ctx.character_id ?? ctx.name2 ?? 'global';
    const bindings = set.characterBindingsMap?.[charId] || [];
    const charName = (ctx.name2 || '').toLowerCase();
    const binding  = bindings.find(b => {
        const n = (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 :
                   b.targetType === TARGET_TYPE.CURRENT_USER      ? ctx.name1 : b.customName)?.toLowerCase();
        return n === charName;
    });

    const ttsParams = {
        text,
        apiHost:  set.apiHost,
        model:    binding?.model   || set.model,
        voiceId:  binding?.voiceId || set.voiceId,
        speed:    Number(set.speed),
        volume:   Number(set.vol),
        pitch:    Number(set.pitch),
        format:   'mp3',
        emotion:  set.emotion || '',
    };

    // 先尝试代理
    try {
        const res = await fetch(PROXY_ENDPOINT, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(ttsParams),
        });
        if (res.status === 404 || res.status === 501 || res.status === 405) {
            throw new Error('PROXY_NOT_AVAILABLE');
        }
        if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
        return await res.blob();
    } catch (proxyErr) {
        // fallback 直连
        return await directMinimaxTts(text, {
            model: ttsParams.model,
            voiceId: ttsParams.voiceId,
            speed: ttsParams.speed,
            vol: ttsParams.volume,
            pitch: ttsParams.pitch,
            audioFormat: ttsParams.format,
            emotion: ttsParams.emotion,
        });
    }
}

function vcLog(speaker, text) {
    const log = vcEl('vc-log');
    if (!log) return;
    const el = document.createElement('div');
    el.className = `vc-log-line vc-log-${speaker}`;
    el.textContent = (speaker === 'user' ? '你: ' : 'TA: ') + text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
}

function vcResumeListening() {
    if (vcState !== 'listening' || vcMuted) return;
    vcStartWebSpeech();
}

function vcStartWebSpeech() {
    if (vcState !== 'listening' || vcMuted) return;
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        toastr.error('当前浏览器不支持语音识别，请用 Chrome 或 Edge');
        vcEndCall();
        return;
    }

    vcSpeechRec = new SpeechRec();
    vcSpeechRec.lang           = vc().sttLang || navigator.language || 'zh-CN';
    vcSpeechRec.continuous     = false;
    vcSpeechRec.interimResults = true;
    vcSpeechRec.maxAlternatives = 1;

    const logEl = vcEl('vc-log');
    let liveEl = null;

    const removeLive = () => {
        if (liveEl && !liveEl.textContent.replace('你: ', '').trim()) liveEl.remove();
        liveEl = null;
    };

    vcSpeechRec.onresult = async (e) => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) final += t;
            else interim += t;
        }

        const display = final || interim;
        if (display && logEl) {
            if (!liveEl) {
                liveEl = document.createElement('div');
                liveEl.className = 'vc-log-line vc-log-user vc-log-interim';
                logEl.appendChild(liveEl);
            }
            liveEl.textContent = '你: ' + display;
            liveEl.classList.toggle('vc-log-interim', !final);
            logEl.scrollTop = logEl.scrollHeight;
        }

        if (!final) return;

        const text = final.trim();
        if (!text) { removeLive(); if (vcState === 'listening') vcStartWebSpeech(); return; }

        liveEl = null;
        vcSetState('thinking');
        await vcStreamingLlm(text);
    };

    vcSpeechRec.onend = () => {
        removeLive();
        if (vcState === 'listening' && !vcMuted) vcStartWebSpeech();
    };

    vcSpeechRec.onerror = (e) => {
        removeLive();
        if (['aborted', 'no-speech', 'audio-capture'].includes(e.error)) {
            if (vcState === 'listening' && !vcMuted) vcStartWebSpeech();
        } else {
            console.warn('[VC STT] error:', e.error);
        }
    };

    vcSpeechRec.start();
}

function vcStartWaveform() {
    const loop = () => {
        if (!vcActive) return;
        const canvas = vcEl('vc-canvas');
        if (!canvas) { requestAnimationFrame(loop); return; }
        const ctx2d = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx2d.clearRect(0, 0, W, H);

        if (vcAnalyser && (vcState === 'listening' || vcState === 'recording')) {
            const buf  = new Uint8Array(vcAnalyser.frequencyBinCount);
            vcAnalyser.getByteFrequencyData(buf);
            const n = 32, step = Math.floor(buf.length / n), barW = W / n - 2;
            for (let i = 0; i < n; i++) {
                const v = buf[i * step] / 255;
                const h = Math.max(3, v * H * 0.85);
                ctx2d.fillStyle = vcState === 'recording'
                    ? `rgba(255,90,90,${0.45 + v * 0.55})`
                    : `rgba(70,195,130,${0.35 + v * 0.65})`;
                ctx2d.fillRect(i * (barW + 2), (H - h) / 2, barW, h);
            }
        } else {
            const t   = Date.now() / 1000;
            const amp = vcState === 'thinking' || vcState === 'processing'
                ? 4 + Math.sin(t * 7) * 3
                : vcState === 'speaking' ? 7 + Math.sin(t * 4) * 4 : 6;
            const rgb = vcState === 'speaking'           ? '110,150,255'
                      : vcState === 'thinking' || vcState === 'processing' ? '255,175,70'
                      : '70,195,130';
            ctx2d.strokeStyle = `rgba(${rgb},0.75)`;
            ctx2d.lineWidth   = 2;
            ctx2d.beginPath();
            for (let x = 0; x <= W; x++) {
                const y = H / 2 + Math.sin((x / W * 5 + t * 2) * Math.PI) * amp;
                x === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
            }
            ctx2d.stroke();
        }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}

async function vcStartCall() {
    vcLoadSettings();
    if (callMode === 'voice' && !vc().vcEnabled) return;
    if (callMode === 'video' && !s().vrmEnabled)  return;

    if (vcPlaybackCtx) { try { vcPlaybackCtx.close(); } catch (_) {} }
    vcPlaybackCtx = new (window.AudioContext || window.webkitAudioContext)();

    vrmAnalyserNode = null;
    if (callMode === 'video') {
        try {
            vrmAnalyserNode = vcPlaybackCtx.createAnalyser();
            vrmAnalyserNode.fftSize = 256;
        } catch (_) {}
        document.documentElement.classList.add('mm-vc-active');
        applyVrmBg();
        (async () => {
            try {
                if (!vrmModule) vrmModule = await import('./vrm.js');
                const canvas = document.getElementById('vc-vrm-canvas');
                if (canvas) {
                    await vrmModule.init(canvas, s().vrmPixelRatio ?? 1);
                    const modelUrl = s().vrmModelUrl?.trim();
                    if (modelUrl) {
                        await vrmModule.loadModel(modelUrl);
                    } else {
                        toastr.warning('VRM 模型未找到，请在设置中上传 VRM 文件。', '', { timeOut: 10000 });
                    }
                    if (vrmAnalyserNode) vrmModule.setAnalyser(vrmAnalyserNode);
                    vrmModule.resize(canvas);
                    vrmModule.setState('listening');
                }
            } catch (e) {
                console.warn('[VRM] 初始化失败', e);
                toastr.warning('VRM 加载失败：' + e.message, '', { timeOut: 6000 });
            }
        })();
    }

    activeAudio.pause();
    activeAudio.src = '';
    playbackQueue.length = 0;

    vcSetState('connecting');

    const ctx = getContext();
    const nameEl = vcEl('vc-name');
    if (nameEl) nameEl.textContent = ctx.name2 || 'AI';
    if (callMode === 'voice') {
        const avatarEl = document.getElementById('vc-avatar');
        const phEl     = document.getElementById('vc-avatar-placeholder');
        const charAvatar = ctx.characters?.[ctx.characterId]?.avatar;
        if (avatarEl) { avatarEl.src = charAvatar ? `/characters/${charAvatar}` : ''; avatarEl.style.display = charAvatar ? '' : 'none'; }
        if (phEl)     phEl.style.display = charAvatar ? 'none' : '';
        document.getElementById('vc-dialog').classList.add('vc-dialog-open');
    }

    vcStartTime = Date.now();
    const timerEl = vcEl('vc-timer');
    vcTimerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - vcStartTime) / 1000);
        if (timerEl) timerEl.textContent = `${String(Math.floor(sec / 60)).padStart(2,'0')}:${String(sec % 60).padStart(2,'0')}`;
    }, 1000);

    vcStartWaveform();

    vcSetState('listening');
    vcStartWebSpeech();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (!vcActive) { stream.getTracks().forEach(t => t.stop()); return; }
        vcStream = stream;
        vcAudioCtx = new AudioContext();
        const src  = vcAudioCtx.createMediaStreamSource(stream);
        vcAnalyser = vcAudioCtx.createAnalyser();
        vcAnalyser.fftSize = 512;
        src.connect(vcAnalyser);
    }).catch(() => {});
}

function vcEndCall() {
    if (vcLlmAbortCtrl) { vcLlmAbortCtrl.abort(); vcLlmAbortCtrl = null; }
    vcStreamBuffer = '';
    vcCurrentResponseAudioItems = null;
    vcTtsPipeline.length = 0; vcTtsDraining = false; vcGenDone = true;
    const logSnapshot = vcCallLog.slice();
    vcCallLog = [];
    if (vc().vcInjectOnEnd && logSnapshot.length) vcInjectCallRecord(logSnapshot);
    if (vcSpeechRec)  { try { vcSpeechRec.abort(); } catch (_) {} vcSpeechRec = null; }
    if (vcSpeakAudio)  {
        try { if (typeof vcSpeakAudio.stop === 'function') vcSpeakAudio.stop(); else vcSpeakAudio.pause(); } catch (_) {}
        vcSpeakAudio = null;
    }
    if (vcRafId)       { cancelAnimationFrame(vcRafId); vcRafId = null; }
    if (vcAudioCtx)    { try { vcAudioCtx.close(); } catch (_) {} vcAudioCtx = null; }
    if (vcPlaybackCtx) { try { vcPlaybackCtx.close(); } catch (_) {} vcPlaybackCtx = null; }
    if (vcStream)      { vcStream.getTracks().forEach(t => t.stop()); vcStream = null; }
    vcAnalyser = null;

    if (vrmModule) { try { vrmModule.destroy(); } catch (_) {} }
    vrmAnalyserNode = null;
    document.documentElement.classList.remove('mm-vc-active');
    if (vcTimerInterval) { clearInterval(vcTimerInterval); vcTimerInterval = null; }

    if (callMode === 'voice') document.getElementById('vc-dialog')?.classList.remove('vc-dialog-open');
    const log = vcEl('vc-log');
    if (log) log.innerHTML = '';
    vcMuted = false;
    const muteBtn = vcEl('vc-mute');
    if (muteBtn) {
        muteBtn.classList.remove('vc-btn-muted');
        const icon = muteBtn.querySelector('i');
        if (icon) icon.className = 'fa-solid fa-microphone';
    }
    vcSetState('idle');
}

function vcToggleMute() {
    vcMuted = !vcMuted;
    const btn = vcEl('vc-mute');
    if (btn) {
        btn.classList.toggle('vc-btn-muted', vcMuted);
        const icon = btn.querySelector('i');
        if (icon) icon.className = vcMuted ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone';
    }
    if (vcMuted && vcSpeechRec) { try { vcSpeechRec.abort(); } catch (_) {} }
    if (!vcMuted && vcState === 'listening') vcStartWebSpeech();
    if (vcState === 'listening') vcSetState('listening');
}

function vcCreateUi() {
    const fab = document.createElement('div');
    fab.id    = 'vc-fab';
    fab.title = '语音通话';
    fab.innerHTML = '<i class="fa-solid fa-phone"></i>';
    if (vc().vcEnabled === false) fab.style.display = 'none';
    document.documentElement.appendChild(fab);

    let dragging = false, wasDragged = false, ox = 0, oy = 0;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const fabTakeOver = (x, y) => {
        fab.style.left = clamp(x, 0, window.innerWidth  - 52) + 'px';
        fab.style.top  = clamp(y, 0, window.innerHeight - 52) + 'px';
    };

    try {
        const p = JSON.parse(localStorage.getItem('vc-fab-pos') || 'null');
        if (p && typeof p.l === 'number') fabTakeOver(p.l, p.t);
        else fabTakeOver((window.innerWidth - 52) / 2, window.innerHeight - 52 - 80);
    } catch (_) {
        fabTakeOver((window.innerWidth - 52) / 2, window.innerHeight - 52 - 80);
    }

    fab.addEventListener('pointerdown', e => {
        dragging = true; wasDragged = false;
        fab.setPointerCapture(e.pointerId);
        const r = fab.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        fab.style.transition = 'box-shadow 0.18s ease';
        e.preventDefault();
    }, { passive: false });

    fab.addEventListener('pointermove', e => {
        if (!dragging) return;
        fabTakeOver(e.clientX - ox, e.clientY - oy);
        wasDragged = true;
        e.preventDefault();
    }, { passive: false });

    const onPointerEnd = e => {
        if (!dragging) return;
        dragging = false;
        fab.releasePointerCapture(e.pointerId);
        fab.style.transition = '';
        if (wasDragged) {
            const r = fab.getBoundingClientRect();
            try { localStorage.setItem('vc-fab-pos', JSON.stringify({ l: r.left, t: r.top })); } catch (_) {}
        }
    };
    fab.addEventListener('pointerup',     onPointerEnd);
    fab.addEventListener('pointercancel', onPointerEnd);

    fab.addEventListener('click', () => {
        if (wasDragged) { wasDragged = false; return; }
        if (vcState === 'idle') { callMode = 'voice'; vcStartCall(); } else vcEndCall();
    });

    window.addEventListener('resize', () => {
        if (fab.style.left) {
            fab.style.left = clamp(parseFloat(fab.style.left), 0, window.innerWidth  - 52) + 'px';
            fab.style.top  = clamp(parseFloat(fab.style.top),  0, window.innerHeight - 52) + 'px';
        }
        const vrmC = document.getElementById('vc-vrm-canvas');
        if (vrmC && vrmModule?.isReady?.() && document.documentElement.classList.contains('mm-vc-active'))
            vrmModule.resize(vrmC);
    }, { passive: true });

    const dialog = document.createElement('div');
    dialog.id = 'vc-dialog';
    dialog.innerHTML = `
        <div class="vc-card">
            <div class="vc-avatar-wrap">
                <div class="vc-ripple r1"></div>
                <div class="vc-ripple r2"></div>
                <div class="vc-ripple r3"></div>
                <img id="vc-avatar" src="" alt="" style="display:none">
                <div id="vc-avatar-placeholder" class="vc-avatar-placeholder">
                    <i class="fa-solid fa-robot"></i>
                </div>
            </div>
            <div id="vc-name" class="vc-name">接通中...</div>
            <div class="vc-meta">
                <span id="vc-timer">00:00</span>
                <span class="vc-dot">·</span>
                <span id="vc-status">连接中</span>
            </div>
            <canvas id="vc-canvas" width="240" height="48"></canvas>
            <div id="vc-log" class="vc-log"></div>
            <div class="vc-controls">
                <button id="vc-mute" class="vc-btn" title="静音">
                    <i class="fa-solid fa-microphone"></i><span>静音</span>
                </button>
                <button id="vc-hangup" class="vc-btn vc-btn-end" title="挂断">
                    <i class="fa-solid fa-phone-slash"></i><span>挂断</span>
                </button>
            </div>
        </div>`;
    document.documentElement.appendChild(dialog);
    document.getElementById('vc-hangup').addEventListener('click', vcEndCall);
    document.getElementById('vc-mute').addEventListener('click', vcToggleMute);

    // VRM FAB
    const vrmFab = document.createElement('div');
    vrmFab.id    = 'vrm-fab';
    vrmFab.title = '视频通话';
    vrmFab.innerHTML = '<i class="fa-solid fa-video"></i>';
    if (!s().vrmEnabled) vrmFab.style.display = 'none';
    document.documentElement.appendChild(vrmFab);

    {
        let vDragging = false, vWasDragged = false, vox = 0, voy = 0;
        const vClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const vTakeOver = (x, y) => {
            vrmFab.style.left = vClamp(x, 0, window.innerWidth  - 52) + 'px';
            vrmFab.style.top  = vClamp(y, 0, window.innerHeight - 52) + 'px';
        };
        try {
            const p = JSON.parse(localStorage.getItem('vrm-fab-pos') || 'null');
            if (p && typeof p.l === 'number') vTakeOver(p.l, p.t);
            else vTakeOver((window.innerWidth - 52) / 2 + 64, window.innerHeight - 52 - 80);
        } catch (_) { vTakeOver((window.innerWidth - 52) / 2 + 64, window.innerHeight - 52 - 80); }

        vrmFab.addEventListener('pointerdown', e => {
            vDragging = true; vWasDragged = false;
            vrmFab.setPointerCapture(e.pointerId);
            const r = vrmFab.getBoundingClientRect();
            vox = e.clientX - r.left; voy = e.clientY - r.top;
            vrmFab.style.transition = 'box-shadow 0.18s ease';
            e.preventDefault();
        }, { passive: false });
        vrmFab.addEventListener('pointermove', e => {
            if (!vDragging) return;
            vTakeOver(e.clientX - vox, e.clientY - voy);
            vWasDragged = true; e.preventDefault();
        }, { passive: false });
        const vOnEnd = e => {
            if (!vDragging) return;
            vDragging = false;
            vrmFab.releasePointerCapture(e.pointerId);
            vrmFab.style.transition = '';
            if (vWasDragged) {
                const r = vrmFab.getBoundingClientRect();
                try { localStorage.setItem('vrm-fab-pos', JSON.stringify({ l: r.left, t: r.top })); } catch (_) {}
            }
        };
        vrmFab.addEventListener('pointerup',     vOnEnd);
        vrmFab.addEventListener('pointercancel', vOnEnd);
        vrmFab.addEventListener('click', () => {
            if (vWasDragged) { vWasDragged = false; return; }
            if (vcState === 'idle') { callMode = 'video'; vcStartCall(); } else vcEndCall();
        });
        window.addEventListener('resize', () => {
            if (vrmFab.style.left) {
                vrmFab.style.left = vClamp(parseFloat(vrmFab.style.left), 0, window.innerWidth  - 52) + 'px';
                vrmFab.style.top  = vClamp(parseFloat(vrmFab.style.top),  0, window.innerHeight - 52) + 'px';
            }
        }, { passive: true });
    }

    // VRM Frame
    const vrmFrame = document.createElement('div');
    vrmFrame.id = 'mm-vrm-frame';
    vrmFrame.innerHTML = `
        <canvas id="vc-vrm-canvas" width="960" height="1440"></canvas>
        <div id="vc-vrm-progress" class="vc-vrm-progress"></div>
        <div id="mm-vrm-hud">
            <div id="vrm-log" class="vc-log vrm-hud-log"></div>
            <div class="vc-controls vrm-hud-controls">
                <button id="vrm-mute" class="vc-btn" title="静音">
                    <i class="fa-solid fa-microphone"></i><span>静音</span>
                </button>
                <button id="vrm-hangup" class="vc-btn vc-btn-end" title="挂断">
                    <i class="fa-solid fa-phone-slash"></i><span>挂断</span>
                </button>
            </div>
        </div>`;
    document.documentElement.appendChild(vrmFrame);
    document.getElementById('vrm-hangup').addEventListener('click', vcEndCall);
    document.getElementById('vrm-mute').addEventListener('click', vcToggleMute);

    // Info bar
    const infoBar = document.createElement('div');
    infoBar.id = 'mm-vrm-info';
    infoBar.innerHTML = `
        <span id="vrm-info-name">接通中...</span>
        <div class="mm-vrm-meta">
            <span id="vrm-info-timer">00:00</span>
            <span class="mm-vrm-dot">·</span>
            <span id="vrm-info-status">连接中</span>
        </div>`;
    document.documentElement.appendChild(infoBar);
}

jQuery(async () => {
    vcLoadSettings();
    vcCreateUi();
    await restoreVrmBlobUrl();
});
