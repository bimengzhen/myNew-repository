import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced, addOneMessage, saveChatDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const MODULE_NAME = 'minimax_quote_tts';
const PROXY_ENDPOINT = '/api/minimax/generate-voice';
const DEFAULT_API_HOST = 'https://api.minimax.chat';
const API_HOST_OPTIONS = [
    { value: 'https://api.minimax.chat',label: '国内源(api.minimax.chat)' },
    { value: 'https://api.minimax.io',    label: '国际源 (api.minimax.io)' },
    { value: 'https://api.minimaxi.chat', label: '备用源 (api.minimaxi.chat)' },{ value: 'custom',                    label: '🔗 自定义中转站' },
];

const TARGET_TYPE = { CURRENT_CHARACTER: 'current_character', CURRENT_USER: 'current_user', CUSTOM: 'custom' };
const API_FORMATS = { OAI: 'openai', GOOGLE: 'google' };

const MODEL_OPTIONS = [
    { value: 'Speech-2.8-turbo',label: 'Speech-2.8-turbo (最新极速)' },
    { value: 'Speech-2.8-hd',            label: 'Speech-2.8-hd (最新高清)' },
    { value: 'Speech-2.6-turbo',         label: 'Speech-2.6-turbo' },
    { value: 'Speech-2.6-hd',            label: 'Speech-2.6-hd' },
    { value: 'minimax-speech-2.5-turbo', label: 'minimax-speech-2.5-turbo' },
    { value: 'minimax-speech-2.5-hd',    label: 'minimax-speech-2.5-hd' },
    { value: 'speech-02-hd',             label: 'speech-02-hd (旧版)' },
    { value: 'speech-02-turbo',          label: 'speech-02-turbo (旧版)' },{ value: 'speech-01-turbo',          label: 'speech-01-turbo (旧版)' },
    { value: 'speech-01-hd',             label: 'speech-01-hd (旧版)' },
    { value: 'speech-01',                label: 'speech-01 (旧版)' },
];

const defaults = {
    enabled: true, autoPlay: true, showMessageButton: true, onlyCharacter: true,
    apiKey: '', groupId: '', apiHost: DEFAULT_API_HOST, customApiHost: '',
    model: 'speech-02-hd', voiceId: 'male-qn-qingse',
    speed: 1, vol: 1, pitch: 0, emotion: '', audioFormat: 'mp3', ttsLanguage: '',
    maxQuotesPerMessage: 4, minLength: 1, maxLength: 300, ignoreCodeBlocks: true,
    characterBindingsMap: {}, llmPresets: [], formatterTemplates: [],
    formatterEnabled: false, formatterPresetIdx: -1,
    formatterSystemPrompt: '请以严格的 JSON 格式返回：{"segments":[{"text":"...","speaker":"...","emotion":"...","speed":1.0,"vol":1.0,"pitch":0}]}.仅保留可朗读的内容。',
    serverHistory: {},
    voiceLibrary: [],
    regexRules: [],
    regexPresets: [],
    llmPreProcessRules: [],
    showBubbles: false,
};

let playbackQueue = [], isPlaying = false, clickTimer = null;
let activeAudio = new Audio();
const localAudioCache = new Map();

function s() { return extension_settings[MODULE_NAME]; }

function escHtml(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

    try {
        const charWorld = ctx.characters?.[ctx.characterId]?.data?.extensions?.world;
        if (charWorld) worldMap.set(charWorld, '📌角色绑定');
    } catch (_) {}

    try {
        const chatWorld = ctx.chatMetadata?.world_info;
        if (chatWorld && !worldMap.has(chatWorld)) worldMap.set(chatWorld, '💬 聊天绑定');
    } catch (_) {}

    try {
        const selWorlds = ctx.selected_world_info || ctx.selectedWorldInfo || [];
        if (Array.isArray(selWorlds)) {
            for (const n of selWorlds) {
                if (n && !worldMap.has(n)) worldMap.set(n, '🌐 全局启用');
            }
        }
    } catch (_) {}

    try {
        const wiModule = await import('../../../world-info.js');
        const wn = wiModule.world_names;
        if (Array.isArray(wn)) {
            for (const n of wn) {
                if (n && typeof n === 'string' && !worldMap.has(n)) worldMap.set(n, '📚 可用');
            }
        }
    } catch (e) {
        console.warn('[MiniMax] world-info.js 导入失败:', e.message);
    }

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
                    if (n && n !== '' && n.toLowerCase() !== 'none' && !worldMap.has(n)) worldMap.set(n, '📚 可用');
                });
            }
        } catch (_) {}
    }

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

    if (worldMap.size === 0) { console.warn('[MiniMax] 未找到任何世界书'); return []; }
    console.log('[MiniMax] 发现世界书:', [...worldMap.keys()]);

    const allEntries = [];
    for (const [worldName, source] of worldMap) {
        try {
            let data = null;
            if (typeof ctx.loadWorldInfo === 'function') data = await ctx.loadWorldInfo(worldName);
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
                    worldName, source,
                    uid: entry.uid,
                    disabled: !!entry.disable,
                    keys,
                });
            }
        } catch (e) {
            console.warn('[MiniMax] 加载世界书"' + worldName + '" 失败:', e.message);
        }
    }
    return allEntries;
}

function applyPreProcessRules(text) {
    const rules = (s().llmPreProcessRules || []).filter(r => r.enabled && r.pattern);
    if (!rules.length) return text;
    for (const rule of rules) {
        let re;
        try { re = new RegExp(parsePattern(rule.pattern), 'gs'); } catch (e) { continue; }
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
    if (extension_settings[MODULE_NAME]?._loaded) return;
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const settings = extension_settings[MODULE_NAME];
    for (const key in defaults) {
        if (settings[key] === undefined) settings[key] = JSON.parse(JSON.stringify(defaults[key]));
    }
    if (settings.formatterPresets?.length > 0 && settings.llmPresets.length === 0) {
        settings.llmPresets = settings.formatterPresets.map(p => ({
            name: p.name, url: p.url || '', key: p.key || '', format: p.format || API_FORMATS.OAI, model: p.model || '',}));
    }
    if (!settings.llmPresets.length && (settings.formatterApiUrl || settings.vcLlmApiUrl)) {
        const url = settings.formatterApiUrl || settings.vcLlmApiUrl || '';
        const key = settings.formatterApiKey || settings.vcLlmApiKey || '';
        const model = settings.formatterModel || settings.vcLlmModel || '';
        if (url || model) {
            settings.llmPresets.push({ name: '迁移预设', url, key, format: settings.formatterFormat || API_FORMATS.OAI, model });settings.formatterPresetIdx = 0;
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
    delete settings.quoteOnly;
    delete settings.regexMode;
    delete settings.customRegexPattern;
    delete settings.customRegexFlags;
    settings._loaded = true;
}

function simpleHash(t) {
    if (!t) return 0;
    let h = 0;
    for (let i = 0; i < t.length; i++) h = ((h << 5) - h) + t.charCodeAt(i), h |= 0;
    return Math.abs(h);
}

function buildMessageKey(ctx, id, m) {
    return `${ctx.chatId ||'no-chat'}:${id}:${m?.swipe_id || 0}:${simpleHash(m?.mes)}`;
}

function getMessageData(id) {
    const ctx = getContext();
    const m = ctx?.chat?.[id];
    return { ctx, message: m, key: m ? buildMessageKey(ctx, id, m) : '' };
}

function normalizeOaiUrl(url) {
    let u = (url || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!u.endsWith('/chat/completions')) u += '/chat/completions';
    return u;
}

// --- ST Server Sync ---
async function uploadToSTServer(blob, filename) {
    try {
        const reader = new FileReader();
        const base64 = await new Promise(r => {
            reader.onloadend = () => r(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
        });
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `minimax_${filename}`, data: base64 }),
        });
        const data = await res.json();
        return data.path;
    } catch (e) { return null; }
}

async function syncToSTSecrets(apiKey, groupId) {
    try {
        const writes = [];
        if (apiKey) writes.push(fetch('/api/secrets/write', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'api_key_minimax', value: apiKey }),
        }));
        if (groupId) writes.push(fetch('/api/secrets/write', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'minimax_group_id', value: groupId }),
        }));
        await Promise.all(writes);
    } catch (e) {
        console.warn('[MiniMax] secrets同步失败:', e.message);
    }
}

async function proxyFetch(url, options = {}) {
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: options.body != null ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) throw new Error(data?.error?.message || data?.error || (typeof data === 'string' ? data : `HTTP ${res.status}`));
    return data;
}

async function directMinimaxTts(text, options) {
    const set = s();
    const apiKey = (set.apiKey || '').trim();
    if (!apiKey) throw new Error('请先填写 API Key');

    let apiHost = (set.apiHost || DEFAULT_API_HOST).replace(/\/+$/, '');
    let url;
    let isRelay = false;

    if (apiHost ==='custom') {
        const customHost = (set.customApiHost || '').trim().replace(/\/+$/, '');
        if (!customHost) throw new Error('请在「中转地址」中填写完整的中转站URL（如 https://xxx.com/v1/t2a_v2）');
        url = customHost;
        isRelay = true;
    } else {
        const groupId = (set.groupId || '').trim();
        url = `${apiHost}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;
    }

    // 构建标准 MiniMax 格式请求体（中转站和官方 API 都用同一份）
    const body = {
        model: options.model || set.model,
        text: text,
        stream: false,
        voice_setting: {
            voice_id: options.voiceId || set.voiceId,
            speed:Number(options.speed ?? set.speed),
            vol:      Number(options.vol?? set.vol),
            pitch:    Number(options.pitch ?? set.pitch),},
        audio_setting: {
            sample_rate: 32000,
            bitrate:     128000,
            format:      options.audioFormat ||'mp3',
            channel:     1,
        },
    };

    if (options.emotion) body.voice_setting.emotion = options.emotion;

    const lang = options.language || set.ttsLanguage;
    if (lang) body.language_boost = lang;

    console.log('[MiniMax TTS] 请求:', url, 'model:', body.model, 'relay:', isRelay);

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
        try {
            const e = await res.json();
            msg = e.base_resp?.status_msg || e.error?.message || e.message || e.detail || msg;
        } catch (_) {
            try { msg = await res.text(); } catch (_) {}
        }
        throw new Error(msg);
    }

    // 直接返回音频流
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('audio/') || ct.includes('octet-stream')) {
        return await res.blob();
    }

    // JSON 响应
    const data = await res.json();

    // 官方 API 错误码检查
    if (data.base_resp?.status_code !== 0 && data.base_resp?.status_code !== undefined) {
        throw new Error(data.base_resp?.status_msg || 'API 返回错误');
    }

    // ★ 优先检测 URL 型响应（中转站常见）
    const audioUrl =
        data.data?.audio_url  ||
        data.audio_url        ||
        data.data?.url        ||
        data.url              ||
        data.data?.audio_file ||
        data.audio_file;

    if (audioUrl && typeof audioUrl === 'string' && audioUrl.startsWith('http')) {
        console.log('[MiniMax TTS] 中转站返回 URL，正在下载音频...');
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) throw new Error(`音频下载失败: HTTP ${audioRes.status}`);
        return await audioRes.blob();
    }

    // base64 型响应（官方 API 标准）
    const audioData =
        data.data?.audio ||
        data.audio       ||
        data.audio_data;

    if (!audioData) {
        console.error('[MiniMax TTS] 未知响应格式:', JSON.stringify(data).slice(0, 300));
        throw new Error('API 返回无音频数据，请检查控制台查看完整响应');
    }

    const byteChars = atob(audioData);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', flac: 'audio/flac' };
    return new Blob([byteArray], { type: mimeMap[options.audioFormat] || 'audio/mpeg' });
}

async function getAudioBlob(item) {
    const cacheKey = `tts_${simpleHash(item.text)}_${simpleHash(JSON.stringify(item.options))}`;
    if (localAudioCache.has(cacheKey)) return localAudioCache.get(cacheKey);
    if (item.serverPath) {
        const res = await fetch(item.serverPath, { headers: getRequestHeaders() });
        if (res.ok) { const b = await res.blob(); localAudioCache.set(cacheKey, b); return b; }
    }

    let blob;
    try {
        const set = s();
        const res = await fetch(PROXY_ENDPOINT, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: item.text, apiHost: set.apiHost, model: item.options.model, voiceId: item.options.voiceId,
                speed: item.options.speed, volume: item.options.vol, pitch: item.options.pitch,
                format: item.options.audioFormat, emotion: item.options.emotion,
                language: item.options.language || undefined,
            }),
        });
        if (res.status === 404|| res.status === 501|| res.status === 405) throw new Error('PROXY_NOT_AVAILABLE');
        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try { const e = await res.json(); msg = e.error || e.message || msg; } catch (_) {}
            throw new Error(msg);
        }
        blob = await res.blob();
    } catch (proxyErr) {
        console.warn('[MiniMax] 代理端点失败，尝试直连:', proxyErr.message);
        blob = await directMinimaxTts(item.text, item.options);
    }

    localAudioCache.set(cacheKey, blob);
    uploadToSTServer(blob, `${cacheKey}.${item.options.audioFormat || 'mp3'}`).then(path => {
        if (path) { item.serverPath = path; saveSettingsDebounced(); }
    });
    return blob;
}

// --- Player ---
async function playNext() {
    if (playbackQueue.length === 0) { isPlaying = false; return; }
    isPlaying = true;
    const item = playbackQueue.shift();
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
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(preset.key ? { 'Authorization': `Bearer ${preset.key.trim()}` } : {}) },
                body: { model: preset.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: applyPreProcessRules(m.mes) }], temperature: 0.1},
            });
            text = data.choices?.[0]?.message?.content;
        } else {
            const baseUrl = (preset.url || '').trim().replace(/\/+$/, '');
            const gUrl = `${baseUrl}/v1beta/models/${preset.model}:generateContent`;
            const gHeaders = {'Content-Type': 'application/json', ...(preset.key ? { 'x-goog-api-key': preset.key.trim() } : {}) };
            const data = await proxyFetch(gUrl, {
                method: 'POST', headers: gHeaders,
                body: { contents: [{ role: 'user', parts: [{ text: `System Prompt: ${prompt}\n\nUser Message: ${applyPreProcessRules(m.mes)}` }] }] },
            });
            text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        }
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('AI 无有效 JSON');
        return JSON.parse(match[0])?.segments || null;
    } catch (e) { throw e; }
}

function findCharacterBinding(speakerName) {
    if (!speakerName) return null;
    const set = s(), ctx = getContext(), name = speakerName.toLowerCase();
    const id = ctx.characterId || ctx.character_id || ctx.name2 || 'global';
    const bindings = set.characterBindingsMap[id] || [];
    return bindings.find(b => {
        const bName = (b.targetType === TARGET_TYPE.CUSTOM ? b.customName :
            (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 : ctx.name1))?.toLowerCase();
        return bName === name;
    });
}

function buildSynthesisOptions(seg, m) {
    const set = s();
    const b = findCharacterBinding(seg?.speaker || m?.name);
    return {
        model:seg?.model   || b?.model   || set.model,
        voiceId:     seg?.voiceId || b?.voiceId || set.voiceId,
        speed:       Number(seg?.speed ?? set.speed),
        vol:         Number(seg?.vol   ?? set.vol   ??1.0),
        pitch:       Number(seg?.pitch ?? set.pitch ?? 0),
        emotion:     seg?.emotion || set.emotion || undefined,
        audioFormat: set.audioFormat || 'mp3',
        language:    set.ttsLanguage || undefined,};
}

function buildRegex(rule) {
    const flags = (rule.flags || 'g');
    const finalFlags = flags.includes('g') ? flags : flags + 'g';
    return new RegExp(parsePattern(rule.pattern), finalFlags);
}

async function generateMessageSpeech(id, forced = false) {
    const { message, key } = getMessageData(id);
    if (!message || (s().onlyCharacter && message.is_user)) return false;
    const h = s().serverHistory[key];
    if (!forced && h?.versions?.length) return true;
    try {
        let raw;
        if (s().formatterEnabled) {
            raw = await formatWithSecondaryApi(message);
        } else {
            const cleanText = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
            const rules = (s().regexRules || []).filter(r => r.enabled);
            if (!rules.length) {
                raw = [];} else {
                let extracted = [];
                for (const rule of rules.filter(r => r.mode === 'extract')) {
                    let re; try { re = buildRegex(rule); } catch (e) { continue; }
                    let qm;
                    while ((qm = re.exec(cleanText)) !== null) {
                        const t = (qm[1]?.replace(/\n+/g, ' ').trim()) || (qm[0]?.replace(/\n+/g, ' ').trim());
                        if (t) extracted.push({ text: t, speaker: message.name });
                    }
                }
                for (const rule of rules.filter(r => r.mode === 'exclude')) {
                    let re; try { re = buildRegex(rule); } catch (e) { continue; }
                    extracted = extracted.filter(seg => !re.test(seg.text));
                }
                raw = extracted;
            }
        }
        const items = raw.map(seg => ({
            text: seg.text, speaker: seg.speaker || message.name,
            options: buildSynthesisOptions(seg, message), serverPath: null,
        }));
        if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
        s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
        s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
        saveSettingsDebounced(); refreshAllMessageButtons(); injectBubbles(id);
        return true;
    } catch (e) { toastr.error('生成失败: ' + e.message); return false; }
}

function extractSegmentsOnly(id) {
    if (!s().showBubbles) return false;
    const { message, key } = getMessageData(id);
    if (!message || message.is_system || (s().onlyCharacter && message.is_user)) return false;
    if (s().serverHistory[key]?.versions?.length) return true;
    if(/class="/.test(message.mes)) return false;
    if (s().formatterEnabled) return false;
    const cleanText = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
    const rules = (s().regexRules || []).filter(r => r.enabled);
    if (!rules.length) return false;
    let extracted = [];
    for (const rule of rules.filter(r => r.mode === 'extract')) {
        let re; try { re = buildRegex(rule); } catch (e) { continue; }
        let qm;
        while ((qm = re.exec(cleanText)) !== null) {
            const t = (qm[1]?.replace(/\n+/g, ' ').trim()) || (qm[0]?.replace(/\n+/g, ' ').trim());
            if (t) extracted.push({ text: t, speaker: message.name });
        }
    }
    for (const rule of rules.filter(r => r.mode === 'exclude')) {
        let re; try { re = buildRegex(rule); } catch (e) { continue; }
        extracted = extracted.filter(seg => !re.test(seg.text));
    }
    if (!extracted.length) return false;
    const items = extracted.map(seg => ({
        text: seg.text, speaker: seg.speaker || message.name,
        options: buildSynthesisOptions(seg, message), serverPath: null,
    }));
    if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
    s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
    s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
    saveSettingsDebounced();
    return true;
}

async function playGeneratedMessage(id) {
    const { key } = getMessageData(id);
    const h = s().serverHistory[key];
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
        if (!btn) {
            btn = document.createElement('div');
            btn.className = 'mes_button mes_quote_tts fa-solid fa-volume-high';
            extra.appendChild(btn);
        }
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
        acceptNode: n => n.parentElement.closest('.mm-bubble, .mm-bubble-strip')? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
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
    if(/class="/.test(message.mes || '')) return;
    const h = s().serverHistory[key];
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesid}"]`);
    if (!mesEl) return;
    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return;

    const allItems = h?.versions?.[h.activeIndex]?.items || [];
    const items = allItems.map((it, idx) => ({ it, idx })).filter(({ it }) => !it.pauseMs && it.text);

    const isQuoteMode = !s().formatterEnabled && (s().regexRules || []).some(r => r.enabled && r.mode === 'extract');
    const ver = `${key}:${h?.activeIndex}:${items.length}:${isQuoteMode ? 'q' : 'f'}`;

    if (textEl.dataset.mmBubVer === ver) { refreshBubbleStates(mesid); return; }

    textEl.querySelectorAll('.mm-bubble').forEach(el => el.remove());
    textEl.querySelector('.mm-bubble-strip')?.remove();
    if (!items.length) { delete textEl.dataset.mmBubVer; return; }

    const unmatched = [];
    items.forEach(({ it: item, idx }) => {
        const bubble = makeBubble(mesid, idx, item, false);
        if (isQuoteMode) {
            if (!injectAfterClosingQuote(textEl, item.text, bubble)) unmatched.push({ item, idx });
        } else {
            if (!injectAfterText(textEl, item.text, bubble)) unmatched.push({ item, idx });
        }
    });

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
        extractSegmentsOnly(id);injectBubbles(id);
    });
}

function removeAllBubbles() {
    document.querySelectorAll('.mm-bubble, .mm-bubble-strip').forEach(el => el.remove());
    document.querySelectorAll('[data-mm-bub-ver]').forEach(el => el.removeAttribute('data-mm-bub-ver'));
}

function openParamsEditor(id) {
    const { key } = getMessageData(id);
    let h = s().serverHistory[key];
    if (!h?.versions?.length) return;
    const render = () => {
        const v = h.versions[h.activeIndex];
        const rows = v.items.map((it, i) => `
            <div class="minimax-tts-editor-item">
                <div style="font-size:0.8rem;opacity:0.6;margin-bottom:4px;">说话人:
                    <input class="edit-v" data-prop="speaker" data-idx="${i}" value="${it.speaker || ''}" style="width:100px;height:20px !important;display:inline-block;border:none !important;background:none !important;color:inherit !important;padding:0 !important;">
                </div>
                <textarea class="text_pole" readonly style="width:100%;height:40px;margin-bottom:8px;background:rgba(0,0,0,0.2) !important;">${it.text}</textarea>
                <div class="minimax-tts-editor-grid">
                    <div class="minimax-tts-editor-row-flex"><label>模型</label><select class="text_pole edit-v" data-prop="model" data-idx="${i}">${MODEL_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
                    <div class="minimax-tts-editor-row-flex"><label>语音</label><input class="text_pole edit-v" data-prop="voiceId" data-idx="${i}" value="${it.options.voiceId}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>情感</label><input class="text_pole edit-v" data-prop="emotion" data-idx="${i}" value="${it.options.emotion || ''}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>语速</label><input class="text_pole edit-v" data-prop="speed" type="number" step="0.1" data-idx="${i}" value="${it.options.speed}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音量</label><input class="text_pole edit-v" data-prop="vol" type="number" step="0.1" data-idx="${i}" value="${it.options.vol}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音调</label><input class="text_pole edit-v" data-prop="pitch" type="number" step="1" data-idx="${i}" value="${it.options.pitch}"></div>
                </div>
            </div>`).join('');
        const html = `
        <div id="minimax_quote_tts_editor" class="minimax-tts-editor-mask">
          <div class="minimax-tts-editor-dialog">
            <div class="minimax-tts-editor-header">
                <div style="font-weight:bold;font-size:1.1rem;flex:1">版本历史 ${h.activeIndex + 1}/${h.versions.length}</div>
                <div style="display:flex;gap:10px;align-items:center;justify-content:center;flex:1">
                    <button class="menu_button v-prev" style="width:40px;">&lt;</button>
                    <button class="menu_button v-next" style="width:40px;">&gt;</button>
                    <button class="menu_button v-del" style="color:#ef5350;" title="删除此版本">删除</button>
                </div>
                <div style="text-align:right;"><button class="menu_button editor-close">关闭面板</button></div>
            </div>
            <div class="minimax-tts-editor-body">${rows}</div>
            <div class="minimax-tts-editor-actions">
                <button class="menu_button editor-save-only" style="height:40px;">保存修改</button>
                <button class="menu_button editor-confirm" style="height:40px;">确认并选择此版本</button>
            </div>
          </div>
        </div>`;
        $('#minimax_quote_tts_editor').remove();
        $('body').append(html);
        $('#minimax_quote_tts_editor .v-prev').on('click', () => { if (h.activeIndex > 0) { h.activeIndex--; render(); } });
        $('#minimax_quote_tts_editor .v-next').on('click', () => { if (h.activeIndex < h.versions.length - 1) { h.activeIndex++; render(); } });
        $('#minimax_quote_tts_editor .v-del').on('click', () => {
            if (h.versions.length <= 1) {
                delete s().serverHistory[key];
                saveSettingsDebounced(); refreshAllMessageButtons();
                $('#minimax_quote_tts_editor').remove();
                return;
            }
            h.versions.splice(h.activeIndex, 1);
            h.activeIndex = Math.min(h.activeIndex, h.versions.length - 1);
            saveSettingsDebounced(); refreshAllMessageButtons(); render();
        });
        const invalidateBubbles = () => {
            const textEl = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
            if (textEl) textEl.removeAttribute('data-mm-bub-ver');
            setTimeout(() => { injectBubbles(id); refreshBubbleStates(id); refreshAllMessageButtons(); }, 100);
        };
        $('#minimax_quote_tts_editor .editor-close').on('click', () => { $('#minimax_quote_tts_editor').remove(); invalidateBubbles(); });$('#minimax_quote_tts_editor .edit-v').on('change input', function () {
            const p = $(this).data('prop'), idx = $(this).data('idx'), val = $(this).val();
            if (p === 'speaker') {
                v.items[idx].speaker = val;const b = findCharacterBinding(val);
                if (b) { v.items[idx].options.model = b.model || s().model; v.items[idx].options.voiceId = b.voiceId || s().voiceId; render(); }
            } else { v.items[idx].options[p] = val; }v.items[idx].serverPath = null;
        });
        $('#minimax_quote_tts_editor .editor-save-only').on('click', () => { saveSettingsDebounced(); toastr.success('已保存'); });
        $('#minimax_quote_tts_editor .editor-confirm').on('click', () => {
            saveSettingsDebounced(); $('#minimax_quote_tts_editor').remove(); refreshAllMessageButtons(); invalidateBubbles();
        });
        $('#minimax_quote_tts_editor select.edit-v').each(function () { $(this).val(v.items[$(this).data('idx')].options.model); });};
    render();
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

function injectStyles() {
    if (document.getElementById('mm-tts-inline-css')) return;
    const style = document.createElement('style');
    style.id = 'mm-tts-inline-css';
    style.textContent = `
/*──配置面板遮罩 ───────────────────────────── */
.mm-config-mask {
    display: none; position: fixed; inset: 0; z-index: 99999;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
    justify-content: center; align-items: center; padding: 16px;
}
.mm-config-mask.mm-config-open { display: flex !important; }
.mm-config-dialog {
    width: min(680px, 96vw); max-height: 92vh;
    background: var(--SmartThemeBlurTintColor, #1a1c2a);
    color: var(--SmartThemeBodyColor, #ccc);
    border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,0.45);
    display: flex; flex-direction: column; overflow: hidden;
}
.mm-config-header {
    display: flex; align-items: center; padding: 10px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; gap: 8px;
}
.mm-config-close {
    background: none; border: none; color: inherit; font-size: 1.2rem;
    cursor: pointer; padding: 4px 8px; opacity: 0.6; flex-shrink: 0;
}
.mm-config-close:hover { opacity: 1; }
.mm-config-body { flex: 1; overflow-y: auto; padding: 16px; }

/* ── Tab 导航 ───────────────────────────────── */
.mm-tab-bar { display: flex; gap: 2px; flex: 1; flex-wrap: wrap; }
.mm-tab {
    background: transparent; border: none; color: inherit;
    padding: 6px 14px; cursor: pointer; border-radius: 8px 8px 0 0;
    font-size: 0.88rem; opacity: 0.55; white-space: nowrap;
}
.mm-tab:hover { opacity: 0.8; background: rgba(255,255,255,0.04); }
.mm-tab.active { opacity: 1; background: rgba(255,255,255,0.08); font-weight: 600; }
.mm-tab-panel { display: none; }
.mm-tab-panel.active { display: block; }

/* ── 表单行─────────────────────────────────── */
.mm-config-dialog .mm-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.mm-config-dialog .mm-row > label { min-width: 85px; flex-shrink: 0; font-size: 0.88rem; opacity: 0.8; }
.mm-config-dialog .text_pole { flex: 1; min-width: 0; max-width: 100%; box-sizing: border-box; height: 34px !important; font-size: 0.88rem !important; }
.mm-config-dialog textarea.text_pole { height: auto !important; min-height: 64px; resize: vertical; }
.mm-config-dialog select.text_pole { flex: 1; min-width: 0; }
.mm-config-dialog input[type="checkbox"] { flex: none; width: 18px; height: 18px; }

/* ── 小标题 / 描述 / 提示 ────────────────────── */
.mm-section-title { font-weight: 600; font-size: 0.95rem; margin: 16px 0 8px; display: flex; align-items: center; gap: 10px; }
.mm-desc { font-size: 0.82rem; opacity: 0.55; margin: 0 0 10px; line-height: 1.4; }
.mm-hint { font-size: 0.8rem; opacity: 0.5; margin: 4px 0 10px; }
.mm-inline-hint { font-size: 0.78rem; opacity: 0.5; white-space: nowrap; }

/* ── 语音库行 ─────────────────────────────── */
.mm-voice-lib-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }

/* ── 角色绑定行 ───────────────────────────── */
.mm-binding-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; flex-wrap: wrap; }
.mm-binding-row .text_pole { flex: 1; min-width: 80px; }

/* ── 正则规则行 ───────────────────────────── */
.mm-rule-header-row { display: flex; gap: 6px; font-size: 0.78rem; opacity: 0.5; padding: 0 0 4px; }
.mm-rule-header-row > span { flex: 1; }
.mm-rule-header-row > .mm-rule-toggle { flex: 0 0 20px; }
.mm-rule-header-row > .mm-rule-mode { flex: 0 0 68px; }
.mm-rule-header-row > .mm-rule-del { flex: 0 0 30px; }
.mm-rule-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
.mm-rule-row .text_pole { flex: 1; min-width: 0; }
.mm-rule-row .mm-rule-toggle { flex: 0 0 20px; }

/* ── 消息按钮 ─────────────────────────────── */
.mes_quote_tts { cursor: pointer; opacity: 0.5; }
.mes_quote_tts:hover { opacity: 0.85; }
.mes_quote_tts.ready { opacity: 1; color: #4caf50; }

/* ── 气泡 ─────────────────────────────────── */
.mm-bubble {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 6px; margin: 0 2px; border-radius: 10px;
    background: rgba(110,160,255,0.12); cursor: pointer;
    font-size: 0.78rem; vertical-align: middle;
    transition: background 0.15s; white-space: nowrap;
}
.mm-bubble:hover { background: rgba(110,160,255,0.25); }
.mm-bubble i { font-size: 0.7rem; }
.mm-bubble-cached { background: rgba(76,175,80,0.15); }
.mm-bubble-cached:hover { background: rgba(76,175,80,0.3); }
.mm-bubble-loading { opacity: 0.5; pointer-events: none; }
.mm-bubble-playing { background: rgba(255,165,0,0.2); }
.mm-bubble-strip {
    display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;
    padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1);
}

/* ── 编辑器弹窗 ───────────────────────────── */
.minimax-tts-editor-mask {
    position: fixed; inset: 0; z-index: 99998; background: rgba(0,0,0,0.6);
    display: flex; justify-content: center; align-items: center; padding: 16px;
}
.minimax-tts-editor-dialog {
    width: min(600px, 94vw); max-height: 88vh;
    background: var(--SmartThemeBlurTintColor, #1a1c2a);
    color: var(--SmartThemeBodyColor, #ccc);
    border-radius: 16px; display: flex; flex-direction: column; overflow: hidden;
}
.minimax-tts-editor-header { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); gap: 8px; }
.minimax-tts-editor-body { flex: 1; overflow-y: auto; padding: 16px; }
.minimax-tts-editor-item { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.minimax-tts-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.minimax-tts-editor-row-flex { display: flex; align-items: center; gap: 6px; }
.minimax-tts-editor-row-flex label { min-width: 36px; font-size: 0.82rem; opacity: 0.7; }
.minimax-tts-editor-actions { display: flex; gap: 10px; padding: 12px 16px; border-top: 1px solid rgba(255,255,255,0.08); }
.minimax-tts-editor-actions .menu_button { flex: 1; }
`;document.head.appendChild(style);
}

function createUi() {
    injectStyles();
    const wandHtml = `<div id="mm_wand_item" class="list-group-item flex-container flexGap5" title="MiniMax TTS 配置"><div class="fa-solid fa-volume-high extensionsMenuExtensionButton"></div>MiniMax语音</div>`;
    $('#extensionsMenu').append(wandHtml);
    $('#mm_wand_item').on('click', () => {
        const menu = document.getElementById('extensionsMenu');
        if (menu) menu.style.display = 'none';
        openConfigPanel();
    });
    loadSettings();
    syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());refreshAllLlmPresetSelects();
    eventSource.on(event_types.CHARACTER_SELECTED, () => { if (document.getElementById('mm_b_rows')) renderBindings(); });
    eventSource.on(event_types.CHAT_CHANGED, () => { if (document.getElementById('mm_b_rows')) renderBindings(); });
}

//── 辅助渲染函数 ────────────────────────────────────────────────────────────────

function renderVoiceLibrary() {
    const container = document.getElementById('mm_voice_lib_rows');
    if (!container) return;
    container.innerHTML = '';
    const lib = s().voiceLibrary || [];
    lib.forEach((v, i) => {
        const el = document.createElement('div');
        el.className = 'mm-voice-lib-row';
        el.innerHTML = `
            <input class="text_pole vl-name" placeholder="名称（如：路人甲女声）" value="${escHtml(v.name || '')}">
            <input class="text_pole vl-id"placeholder="voiceId" value="${escHtml(v.voiceId || '')}">
            <button class="menu_button vl-del" style="padding:4px 10px;flex-shrink:0">×</button>
        `;
        el.querySelector('.vl-name').addEventListener('input', function () { lib[i].name = this.value; saveSettingsDebounced(); refreshVoiceSelects(); });
        el.querySelector('.vl-id').addEventListener('input',function () { lib[i].voiceId = this.value; saveSettingsDebounced(); });
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
            <input class="text_pole mm-rule-name"placeholder="规则名" value="${escHtml(rule.name || '')}">
            <input class="text_pole mm-rule-pattern" placeholder="正则 或 /pattern/" value="${escHtml(rule.pattern || '')}">
            <select class="text_pole mm-rule-mode" style="max-width:68px">
                <option value="extract" ${rule.mode === 'extract' ? 'selected' : ''}>提取</option>
                <option value="exclude" ${rule.mode === 'exclude' ? 'selected' : ''}>排除</option>
            </select>
            <button class="menu_button mm-rule-del" title="删除">×</button>
        `;
        el.querySelector('.mm-rule-toggle').addEventListener('change', function () { rules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input',function () { rules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function () { rules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change',   function () { rules[i].mode = this.value; saveSettingsDebounced(); });
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
            <input class="text_pole mm-rule-name"    placeholder="规则名" value="${escHtml(rule.name || '')}">
            <input class="text_pole mm-rule-pattern" placeholder="正则 或 /pattern/" value="${escHtml(rule.pattern || '')}">
            <select class="text_pole mm-rule-mode" style="max-width:68px">
                <option value="extract" ${rule.mode === 'extract' ? 'selected' : ''}>提取</option>
                <option value="exclude" ${rule.mode === 'exclude' ? 'selected' : ''}>排除</option>
            </select>
            <button class="menu_button mm-rule-del" title="删除">×</button>
        `;
        el.querySelector('.mm-rule-toggle').addEventListener('change', function () { rules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input',    function () { rules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function () { rules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change',   function () { rules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click',     () => { rules.splice(i, 1); saveSettingsDebounced(); renderPreProcessRules(); });
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
                <option value="${TARGET_TYPE.CURRENT_CHARACTER}">${escHtml(c.name2 || '角色')}</option>
                <option value="${TARGET_TYPE.CURRENT_USER}">${escHtml(c.name1 || '你')}</option>
                <option value="${TARGET_TYPE.CUSTOM}">自定义</option>
            </select>
            <input class="text_pole b-name" placeholder="名称" value="${escHtml(b.customName || '')}" style="${b.targetType === TARGET_TYPE.CUSTOM ? '' : 'display:none'}">
            <select class="text_pole b-model">${MODEL_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select>
            <select class="text_pole b-voice-lib mm-voice-sel">${voiceOpts}</select>
            <input class="text_pole b-voice" placeholder="voiceId" value="${escHtml(libMatch ? '' : b.voiceId || '')}" style="${libMatch ? 'display:none' : ''}">
            <button class="menu_button b-del" style="padding:4px 10px;flex-shrink:0">×</button>
        </div>`);
        row.find('.b-type').val(b.targetType).on('change', function () { b.targetType = $(this).val(); renderBindings(); saveSettingsDebounced(); });
        row.find('.b-name').on('input', function () { b.customName = $(this).val(); saveSettingsDebounced(); });
        row.find('.b-model').val(b.model || s().model).on('change', function () { b.model = $(this).val(); saveSettingsDebounced(); });
        row.find('.b-voice-lib').val(libMatch ? b.voiceId : '').on('change', function () {
            const v = $(this).val(); b.voiceId = v;
            row.find('.b-voice').toggle(!v).val(''); saveSettingsDebounced();
        });
        row.find('.b-voice').on('input', function () { b.voiceId = $(this).val(); saveSettingsDebounced(); });
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

function populateConfigFields() {
    const set = s();
    const el = id => document.getElementById(id);
    if (!el('mm_key')) return;

    el('mm_key').value= set.apiKey  || '';
    el('mm_gid').value     = set.groupId || '';
    el('mm_apihost').value = set.apiHost || DEFAULT_API_HOST;
    el('mm_custom_host').value = set.customApiHost || '';
    el('mm_custom_host_row').style.display = set.apiHost ==='custom' ? '' : 'none';
    el('mm_model').value   = set.model|| 'speech-02-hd';
    el('mm_speed').value   = set.speed   ?? 1;
    el('mm_vol').value     = set.vol?? 1;
    el('mm_tts_lang').value = set.ttsLanguage || '';
    el('mm_autoplay').checked= set.autoPlay !== false;
    el('mm_show_bubbles').checked = set.showBubbles || false;

    renderVoiceLibrary(); refreshVoiceSelects();
    const voiceSel   = el('mm_voice_sel');
    const voiceInput = el('mm_voice');
    const libMatch   = (set.voiceLibrary || []).find(v => v.voiceId === set.voiceId);
    if (libMatch) { voiceSel.value = set.voiceId; voiceInput.style.display = 'none'; }
    else { voiceSel.value = ''; voiceInput.value = set.voiceId || ''; voiceInput.style.display = ''; }

    el('mm_f_en').checked    = set.formatterEnabled || false;
    el('mm_f_prompt').value= set.formatterSystemPrompt || '';

    refreshAllLlmPresetSelects();
    if ((s().llmPresets || []).length > 0) {
        el('mm_llm_presets').value = 0;
        loadLlmPresetFieldsGlobal(0);
    }
    if (set.formatterPresetIdx >= 0) el('mm_f_preset_sel').value = set.formatterPresetIdx;

    renderRules(); renderRegexPresets(); renderPreProcessRules();
    renderBindings();
}

function loadLlmPresetFieldsGlobal(i) {
    const p = (s().llmPresets || [])[i]; if (!p) return;
    document.getElementById('mm_llm_url').value    = p.url    || '';
    document.getElementById('mm_llm_key').value    = p.key    || '';
    document.getElementById('mm_llm_format').value = p.format || API_FORMATS.OAI;
    document.getElementById('mm_llm_model').value= p.model  || '';
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
      </div>
      <button class="mm-config-close" title="关闭">✕</button>
    </div>
    <div class="mm-config-body">

      <!-- Tab: TTS配置 -->
      <div class="mm-tab-panel active" data-panel="tts">
        <p class="mm-desc">配置 MiniMax TTS API连接参数及默认音色。</p>
        <div class="mm-row"><label>API Key</label><input id="mm_key" class="text_pole" type="password" autocomplete="off"></div>
        <div class="mm-row"><label>Group ID</label><input id="mm_gid" class="text_pole" type="text" placeholder="中转站可留空"></div>
        <div class="mm-row"><label>API 节点</label><select id="mm_apihost" class="text_pole">
            ${API_HOST_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="mm-row" id="mm_custom_host_row" style="display:none">
          <label>中转地址</label>
          <input id="mm_custom_host" class="text_pole" type="text" placeholder="https://tts.aurastd.com/api/v1/tts（完整请求路径）">
        </div>
        <div class="mm-row"><label>默认模型</label>
          <select id="mm_model" class="text_pole">
            ${MODEL_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="mm-row">
          <label>默认语音</label>
          <select id="mm_voice_sel" class="text_pole mm-voice-sel" style="flex:1"></select>
          <input id="mm_voice" class="text_pole" placeholder="voiceId" style="max-width:160px">
        </div>
        <div class="mm-row"><label>语速</label><input id="mm_speed" class="text_pole" type="number" step="0.1" min="0.5" max="2" style="max-width:80px"></div>
        <div class="mm-row"><label>音量</label><input id="mm_vol" class="text_pole" type="number" step="0.1" min="0" max="10" style="max-width:80px"></div>
        <div class="mm-row">
          <label>语言</label>
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
            <option value="ar">العربية (ar)</option></select>
          <span class="mm-inline-hint">克隆声音使用时建议明确指定语言</span>
        </div>
        <div class="mm-row"><label>自动播放</label><input id="mm_autoplay" type="checkbox"></div>
        <div class="mm-row">
          <label>语音气泡</label>
          <input id="mm_show_bubbles" type="checkbox"><span class="mm-inline-hint">在消息下方注入气泡，点击气泡单独收听该段语音</span>
        </div>
        <div class="mm-row"><button id="mm_test_tts" class="menu_button"><i class="fa-solid fa-play"></i> 测试语音</button></div><div class="mm-section-title">语音库 <button id="mm_add_voice" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">为语音 ID 起名，便于在角色绑定中按名选择。</p>
        <div id="mm_voice_lib_rows"></div>
        <div class="mm-section-title" style="margin-top:16px">角色绑定 <button id="mm_add_b" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">为当前角色卡的各角色分配专属音色，优先级高于默认语音。</p>
        <div id="mm_b_rows"></div>
      </div>

      <!-- Tab: LLM预设 -->
      <div class="mm-tab-panel" data-panel="llm">
        <p class="mm-desc">管理用于 LLM 格式化的 API 预设。</p>
        <div class="mm-row">
          <label>预设</label>
          <select id="mm_llm_presets" class="text_pole llm-preset-sel"></select>
          <button id="mm_llm_save_p" class="menu_button">保存</button>
          <button id="mm_llm_upd_p" class="menu_button">更新</button>
          <button id="mm_llm_del_p" class="menu_button">删除</button>
        </div>
        <div class="mm-row"><label>接口格式</label>
          <select id="mm_llm_format" class="text_pole">
            <option value="${API_FORMATS.OAI}">OpenAI</option>
            <option value="${API_FORMATS.GOOGLE}">Google Gemini</option>
          </select>
        </div>
        <div class="mm-row"><label>API 地址</label><input id="mm_llm_url" class="text_pole" type="text" placeholder="https://api.openai.com/v1"></div>
        <div class="mm-row"><label>API 密钥</label><input id="mm_llm_key" class="text_pole" type="password" autocomplete="off"></div>
        <div class="mm-row">
          <label>AI 模型</label>
          <input id="mm_llm_model" class="text_pole" type="text"><select id="mm_llm_model_sel" class="text_pole" style="display:none"></select>
          <button id="mm_llm_fetch" class="menu_button">获取</button>
          <button id="mm_llm_test_conn" class="menu_button">测试</button>
        </div></div>

      <!-- Tab: 格式化 -->
      <div class="mm-tab-panel" data-panel="format">
        <p class="mm-desc">两种格式化方式：正则规则手动提取；启用副LLM 后交由 AI 结构化处理（支持多角色/情感），两者互斥。</p>
        <div class="mm-section-title">正则文本规则 <button id="mm_add_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <div class="mm-rule-header-row">
          <span class="mm-rule-toggle"></span><span>名称</span><span>正则表达式</span><span class="mm-rule-mode">模式</span><span class="mm-rule-del"></span>
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
        <div class="mm-row"><label>LLM 预设</label><select id="mm_f_preset_sel" class="text_pole llm-preset-sel"></select></div>
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
        </div><div class="mm-section-title" style="margin-top:16px">预处理规则 <button id="mm_add_pre_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">发送给副 LLM 之前，对消息文本执行正则处理（如剔除 &lt;think&gt; 标签）。</p>
        <div class="mm-rule-header-row">
          <span class="mm-rule-toggle"></span><span>名称</span><span>正则表达式</span>
          <span class="mm-rule-mode">模式</span><span class="mm-rule-del"></span>
        </div>
        <div id="mm_pre_rule_rows"></div></div>

    </div>
  </div>
</div>`;document.body.insertAdjacentHTML('beforeend', panelHtml);

        // ── Tab 切换 ──
        document.querySelectorAll('#mm-config-dialog .mm-tab').forEach(tab => {
            tab.addEventListener('click', function () {
                const t = this.dataset.tab;
                document.querySelectorAll('#mm-config-dialog .mm-tab').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                document.querySelectorAll('#mm-config-dialog .mm-tab-panel').forEach(p => p.classList.remove('active'));
                document.querySelector(`#mm-config-dialog .mm-tab-panel[data-panel="${t}"]`).classList.add('active');
                if (t === 'tts'){ renderVoiceLibrary(); refreshVoiceSelects(); renderBindings(); }
                if (t === 'format') { renderRules(); renderRegexPresets(); renderPreProcessRules(); }
            });
        });

        // ── 关闭 ──
        document.getElementById('mm-config-mask').addEventListener('click', function (e) {
            if (e.target === this) this.classList.remove('mm-config-open');
        });
        document.querySelector('#mm-config-dialog .mm-config-close').addEventListener('click', () => {
            document.getElementById('mm-config-mask').classList.remove('mm-config-open');
        });

        // ── TTS 基础 ──
        const syncTts = () => {
            const voiceSel = document.getElementById('mm_voice_sel');
            s().apiKey= document.getElementById('mm_key').value;
            s().groupId      = document.getElementById('mm_gid').value;
            s().apiHost      = document.getElementById('mm_apihost').value;
            s().customApiHost = document.getElementById('mm_custom_host')?.value || '';
            s().model        = document.getElementById('mm_model').value;
            s().voiceId      = voiceSel.value || document.getElementById('mm_voice').value;
            s().speed        = Number(document.getElementById('mm_speed').value);
            s().vol          = Number(document.getElementById('mm_vol').value);
            s().ttsLanguage  = document.getElementById('mm_tts_lang').value;
            s().autoPlay     = document.getElementById('mm_autoplay').checked;
            saveSettingsDebounced();syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());
        };

        document.getElementById('mm_apihost').addEventListener('change', function () {
            const row = document.getElementById('mm_custom_host_row');
            if (row) row.style.display = this.value === 'custom' ? '' : 'none';
        });

        document.getElementById('mm_show_bubbles').addEventListener('change', function () {
            s().showBubbles = this.checked;
            saveSettingsDebounced();if (this.checked) refreshAllBubbles(); else removeAllBubbles();
        });

        ['mm_key', 'mm_gid', 'mm_apihost', 'mm_custom_host', 'mm_model', 'mm_voice_sel', 'mm_voice', 'mm_speed', 'mm_vol', 'mm_tts_lang', 'mm_autoplay'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', syncTts);
            el.addEventListener('change', syncTts);
        });

        document.getElementById('mm_voice_sel').addEventListener('change', function () {
            document.getElementById('mm_voice').style.display = this.value ? 'none' : '';
        });

        const TEST_TEXTS = {
            '': '你好，我是MiniMax语音。','zh': '你好，我是MiniMax语音。',
            'en': 'Hello, I am MiniMax voice.', 'ja': 'こんにちは、MiniMaxの音声です。',
            'ko': '안녕하세요, 저는 MiniMax 음성입니다.', 'fr': 'Bonjour, je suis la voix MiniMax.',
            'de': 'Hallo, ich bin die MiniMax-Stimme.', 'es': 'Hola, soy la voz MiniMax.',
            'pt': 'Olá, sou a voz MiniMax.', 'id': 'Halo, saya adalah suara MiniMax.',
            'ar': 'مرحبًا، أنا صوت MiniMax.',};

        document.getElementById('mm_test_tts').addEventListener('click', async () => {
            try {
                const lang = s().ttsLanguage || '';
                const text = TEST_TEXTS[lang] || TEST_TEXTS[''];
                const item = { text, options: buildSynthesisOptions(null, null), serverPath: null };
                const blob = await getAudioBlob(item);
                new Audio(URL.createObjectURL(blob)).play();
                toastr.success('语音连通成功！');
            } catch (e) { toastr.error('语音测试失败: ' + e.message); }
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

        // ── 正则预设 ──
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
        document.getElementById('mm_regex_presets').addEventListener('change', function () {
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
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().regexPresets || [], null, 2)], { type: 'application/json' }));
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
                } catch (e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });

        // ── 副 LLM 格式化 ──
        const syncFormatter = () => {
            s().formatterEnabled      = document.getElementById('mm_f_en').checked;
            s().formatterPresetIdx    = Number(document.getElementById('mm_f_preset_sel').value);
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
        ['mm_f_en', 'mm_f_preset_sel', 'mm_f_prompt'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', syncFormatter);
            el.addEventListener('change', syncFormatter);
        });
        selFT.addEventListener('change', function () {
            const t = (s().formatterTemplates || [])[Number(this.value)];
            if (t) { document.getElementById('mm_f_prompt').value = t.content; syncFormatter(); }
        });
        document.getElementById('mm_f_save_t').addEventListener('click', () => {
            const n = prompt('模板名:'); if (!n) return;
            if (!s().formatterTemplates) s().formatterTemplates = [];
            s().formatterTemplates.push({ name: n, content: document.getElementById('mm_f_prompt').value });
            upFTemplates(); saveSettingsDebounced();
        });
        document.getElementById('mm_f_upd_t').addEventListener('click', () => {
            const i = Number(selFT.value);
            if (i >= 0) { (s().formatterTemplates || [])[i].content = document.getElementById('mm_f_prompt').value; toastr.success('更新成功'); saveSettingsDebounced(); }
        });
        document.getElementById('mm_f_del_t').addEventListener('click', () => {
            const i = Number(selFT.value);
            if (i >= 0) { (s().formatterTemplates || []).splice(i, 1); upFTemplates(); saveSettingsDebounced(); }
        });
        document.getElementById('mm_f_export_t').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().formatterTemplates || [], null, 2)], { type: 'application/json' }));
            a.download = 'formatter_templates.json'; a.click();
        });
        document.getElementById('mm_f_import_t').addEventListener('click', () => {
            const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async () => {
                try {
                    const data = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(data)) {
                        if (!s().formatterTemplates) s().formatterTemplates = [];
                        s().formatterTemplates.push(...data); upFTemplates(); saveSettingsDebounced();
                        toastr.success(`已导入 ${data.length} 个模板`);
                    }
                } catch (e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });

        // ── LLM 预设 CRUD ──
        document.getElementById('mm_llm_presets').addEventListener('change', function () { loadLlmPresetFieldsGlobal(Number(this.value)); });
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
            refreshAllLlmPresetSelects();
            const newI = Number(document.getElementById('mm_llm_presets').value);
            if (newI >= 0) loadLlmPresetFieldsGlobal(newI);
            else {
                ['mm_llm_url', 'mm_llm_key', 'mm_llm_model'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('mm_llm_format').value = API_FORMATS.OAI;
                document.getElementById('mm_llm_model').style.display     = '';
                document.getElementById('mm_llm_model_sel').style.display = 'none';
            }
            saveSettingsDebounced();});
        document.getElementById('mm_llm_fetch').addEventListener('click', async () => {
            const url= document.getElementById('mm_llm_url').value.trim().replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
            const key    = document.getElementById('mm_llm_key').value.trim();
            const format = document.getElementById('mm_llm_format').value;
            try {
                let m = [];
                if (format === API_FORMATS.OAI) {
                    const d = await proxyFetch(`${url}/models`, { headers: key ? { 'Authorization': `Bearer ${key}` } : {} });
                    m = d.data?.map(it => typeof it === 'string' ? it : it.id) || [];
                } else {
                    const d = await proxyFetch(`${url}/v1beta/models`, { headers: key ? { 'x-goog-api-key': key } : {} });
                    m = d.models?.map(it => it.name.replace('models/', '')) || [];
                }
                if (m.length) {
                    const sel = document.getElementById('mm_llm_model_sel');
                    sel.innerHTML = ''; sel.style.display = '';
                    document.getElementById('mm_llm_model').style.display = 'none';
                    m.forEach(it => { const o = document.createElement('option'); o.value = it; o.textContent = it; sel.appendChild(o); });sel.value = m[0]; toastr.success('获取成功');
                }
            } catch (e) { toastr.error(e.message); }
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
                    d = await proxyFetch(normalizeOaiUrl(url), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(key ? { 'Authorization': `Bearer ${key}` } : {}) },
                        body: { model, messages: [{ role: 'user', content: 'Say connected' }], temperature: 0.1 },
                    });
                } else {
                    const gUrl = `${url.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`;
                    d = await proxyFetch(gUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) },
                        body: { contents: [{ role: 'user', parts: [{ text: 'Say connected' }] }] },
                    });
                }
                if (d) toastr.success('API 连通成功！');
            } catch (e) { toastr.error(e.message); }
        });

        upFTemplates();}

    populateConfigFields();
    document.getElementById('mm-config-mask').classList.add('mm-config-open');
}

jQuery(async () => {
    loadSettings();
    createUi();

    let timer, longP;

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (id) => {
        if (s().enabled && s().autoPlay) {
            if (await generateMessageSpeech(id, false)) {
                playGeneratedMessage(id);
            }
        } else {
            extractSegmentsOnly(id);
        }injectBubbles(id);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(refreshAllBubbles, 600);
    });

    $(document).on('mousedown touchstart', '.mes_quote_tts', function () {
        const id = Number($(this).closest('.mes').attr('mesid'));
        longP = false;
        timer = setTimeout(async () => {
            longP = true;
            if (s().formatterEnabled) {
                toastr.info('生成结构中...');
                if (await generateMessageSpeech(id, true)) toastr.success('生成成功！点击图标播放。');
            } else {
                if (await generateMessageSpeech(id, true)) playGeneratedMessage(id);
            }
        }, 600);
    }).on('mouseup mouseleave touchend touchcancel', '.mes_quote_tts', () => clearTimeout(timer));

    $(document).on('click', '.mes_quote_tts', function (e) {
        if (longP) return;
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(async () => {
            clickTimer = null;
            const id = Number($(e.target).closest('.mes').attr('mesid')), { key } = getMessageData(id);
            if (s().formatterEnabled) {
                if (!s().serverHistory[key] || !s().serverHistory[key].versions.length) return toastr.warning('请先长按。');
                playGeneratedMessage(id);
            } else {
                if (await generateMessageSpeech(id)) playGeneratedMessage(id);
            }
        }, 250);
    }).on('dblclick', '.mes_quote_tts', function (e) {
        e.preventDefault();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openParamsEditor(Number($(this).closest('.mes').attr('mesid')));
    });

    setInterval(() => { refreshAllMessageButtons(); refreshAllBubbles(); }, 1000);

    $(document).on('click', '.mm-bubble', async function () {
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
            audio.onended = () => { URL.revokeObjectURL(url); $b.removeClass('mm-bubble-playing'); };
            audio.onerror = () => { URL.revokeObjectURL(url); $b.removeClass('mm-bubble-playing'); };
            await audio.play();
        } catch (e) {
            $b.removeClass('mm-bubble-loading mm-bubble-playing');
            toastr.error('播放失败: ' + e.message);
        }
    });
});
