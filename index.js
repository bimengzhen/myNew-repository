import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced, addOneMessage, saveChatDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const MODULE_NAME = 'minimax_quote_tts';
const PROXY_ENDPOINT = '/api/minimax/generate-voice';
const DEFAULT_API_HOST = 'https://api.minimax.chat';
const API_HOST_OPTIONS = [
    { value: 'https://api.minimax.chat', label: '国内源(api.minimax.chat)' },
    { value: 'https://api.minimax.io', label: '国际源(api.minimax.io)' },
    { value: 'https://api.minimaxi.chat', label: '备用源(api.minimaxi.chat)' },
    { value: 'custom', label: '🔗自定义中转站' },
];
const TARGET_TYPE = { CURRENT_CHARACTER: 'current_character', CURRENT_USER: 'current_user', CUSTOM: 'custom' };
const API_FORMATS = { OAI: 'openai', GOOGLE: 'google' };
const MODEL_OPTIONS = [
    { value: 'Speech-2.8-turbo', label: 'Speech-2.8-turbo(最新极速)' },
    { value: 'Speech-2.8-hd', label: 'Speech-2.8-hd(最新高清)' },
    { value: 'Speech-2.6-turbo', label: 'Speech-2.6-turbo' },
    { value: 'Speech-2.6-hd', label: 'Speech-2.6-hd' },
    { value: 'minimax-speech-2.5-turbo', label: 'minimax-speech-2.5-turbo' },
    { value: 'minimax-speech-2.5-hd', label: 'minimax-speech-2.5-hd' },
    { value: 'speech-02-hd', label: 'speech-02-hd(旧版)' },
    { value: 'speech-02-turbo', label: 'speech-02-turbo(旧版)' },
    { value: 'speech-01-turbo', label: 'speech-01-turbo(旧版)' },
    { value: 'speech-01-hd', label: 'speech-01-hd(旧版)' },
    { value: 'speech-01', label: 'speech-01(旧版)' },
];

const defaults = {
    enabled: true, autoPlay: true, showMessageButton: true, onlyCharacter: true,
    apiKey: '', groupId: '', apiHost: DEFAULT_API_HOST, customApiHost: '',
    model: 'Speech-2.8-hd', voiceId: 'English_expressive_narrator',
    speed: 1, vol: 1, pitch: 0, emotion: '', audioFormat: 'mp3', ttsLanguage: '',
    maxQuotesPerMessage: 4, minLength: 1, maxLength: 300, ignoreCodeBlocks: true,
    characterBindingsMap: {}, llmPresets: [], formatterTemplates: [],
    formatterEnabled: false, formatterPresetIdx: -1,
    formatterSystemPrompt: '请以严格的JSON格式返回：{"segments":[{"text":"...","speaker":"...","emotion":"...","speed":1.0,"vol":1.0,"pitch":0}]}.仅保留可朗读的内容。',
    serverHistory: {}, voiceLibrary: [], regexRules: [], regexPresets: [],
    llmPreProcessRules: [], showBubbles: false,
};

let playbackQueue = [], isPlaying = false, clickTimer = null;
let activeAudio = new Audio();
const localAudioCache = new Map();

function s() { return extension_settings[MODULE_NAME]; }
function escHtml(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function parsePattern(str) { const p = (str || '').trim(); if (p.startsWith('/')) { const last = p.lastIndexOf('/'); if (last > 0) return p.slice(1, last); } return p; }
function isHtmlMessage(mes) { return /class="|<div[\s>]|<table|<details|<summary|style="/i.test(mes || ''); }
function simpleHash(t) { if (!t) return 0; let h = 0; for (let i = 0; i < t.length; i++) h = ((h << 5) - h) + t.charCodeAt(i), h |= 0; return Math.abs(h); }
function buildMessageKey(ctx, id, m) { return `${ctx.chatId ||'x'}:${id}:${m?.swipe_id || 0}:${simpleHash(m?.mes)}`; }
function getMessageData(id) { const ctx = getContext(), m = ctx?.chat?.[id]; return { ctx, message: m, key: m ? buildMessageKey(ctx, id, m) : '' }; }
function normalizeOaiUrl(url) { let u = (url || '').trim().replace(/\/+$/, ''); if (!u) return ''; if (!u.endsWith('/chat/completions')) u += '/chat/completions'; return u; }

function getBuiltinQuoteRule() {
    return {
        id: 'builtin-quotes', enabled: true, name: '引号内容',
        pattern: '[\\u0022\\u201c\\u300c\\u300e\\u2018]([^\\u0022\\u201c\\u201d\\u300c\\u300d\\u300e\\u300f\\u2018\\u2019]{1,500}?)[\\u0022\\u201d\\u300d\\u300f\\u2019]',
        flags: 'g', mode: 'extract',};
}

function loadSettings() {
    if (extension_settings[MODULE_NAME]?._loaded) return;
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const st = extension_settings[MODULE_NAME];
    for (const k in defaults) if (st[k] === undefined) st[k] = JSON.parse(JSON.stringify(defaults[k]));
    if (st.formatterPresets?.length > 0 && !st.llmPresets.length) {
        st.llmPresets = st.formatterPresets.map(p => ({ name: p.name, url: p.url || '', key: p.key || '', format: p.format || API_FORMATS.OAI, model: p.model || '' }));
    }
    if (!st.llmPresets.length && (st.formatterApiUrl || st.vcLlmApiUrl)) {
        const u = st.formatterApiUrl || st.vcLlmApiUrl || '', k = st.formatterApiKey || st.vcLlmApiKey || '', m = st.formatterModel || st.vcLlmModel || '';
        if (u || m) { st.llmPresets.push({ name: '迁移预设', url: u, key: k, format: st.formatterFormat || API_FORMATS.OAI, model: m }); st.formatterPresetIdx = 0; }
    }
    if (!Array.isArray(st.regexRules) || !st.regexRules.length) {
        st.regexRules = [getBuiltinQuoteRule()];if (st.customRegexPattern && st.regexMode === 'custom') {
            st.regexRules.push({ id: 'migrated-' + Date.now(), enabled: true, name: '迁移正则', pattern: st.customRegexPattern, flags: st.customRegexFlags || 'g', mode: 'extract' });
        }
    }
    delete st.quoteOnly; delete st.regexMode; delete st.customRegexPattern; delete st.customRegexFlags;
    if (!st._bubbleFixV4) {
        st.serverHistory = {};
        st._bubbleFixV4 = true;
    }
    st._loaded = true;
}

async function uploadToSTServer(blob, fn) {
    try {
        const r = new FileReader();
        const b64 = await new Promise(ok => { r.onloadend = () => ok(r.result.split(',')[1]); r.readAsDataURL(blob); });
        const res = await fetch('/api/files/upload', { method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `minimax_${fn}`, data: b64 }) });
        return (await res.json()).path;
    } catch (_) { return null; }
}

async function syncToSTSecrets(ak, gid) {
    try {
        const w = [];
        if (ak) w.push(fetch('/api/secrets/write', { method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'api_key_minimax', value: ak }) }));
        if (gid) w.push(fetch('/api/secrets/write', { method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'minimax_group_id', value: gid }) }));
        await Promise.all(w);
    } catch (_) {}
}

async function proxyFetch(url, opt = {}) {
    const r = await fetch(url, {
        method: opt.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) },
        body: opt.body != null ? JSON.stringify(opt.body) : undefined,
    });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch (_) { d = t; }
    if (!r.ok) throw new Error(d?.error?.message || d?.error || (typeof d === 'string' ? d : `HTTP ${r.status}`));
    return d;
}

function getAudioFieldFromResponse(d) {
    return d.data?.audio_url || d.audio_url || d.data?.url || d.url|| d.data?.audio_file || d.audio_file || d.data?.file_url || d.file_url
        || d.data?.audio || d.audio || d.audio_data || d.data?.audio_data;
}

async function extractAudioFromResponse(d, fmt) {
    const u = d.data?.audio_url || d.audio_url || d.data?.url || d.url
        || d.data?.audio_file || d.audio_file || d.data?.file_url || d.file_url;
    if (u && typeof u === 'string' && (u.startsWith('http') || u.startsWith('//'))) {
        const r = await fetch(u.startsWith('//') ? 'https:' + u : u);
        if (!r.ok) throw new Error('音频下载失败:HTTP' + r.status);
        return await r.blob();
    }
    const a = d.data?.audio || d.audio || d.audio_data || d.data?.audio_data;
    if (a && typeof a === 'string') {
        const bc = atob(a), ba = new Uint8Array(bc.length);
        for (let i = 0; i < bc.length; i++) ba[i] = bc.charCodeAt(i);
        const mm = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', flac: 'audio/flac' };
        return new Blob([ba], { type: mm[fmt] || 'audio/mpeg' });
    }
    const h = d.data?.audio_hex || d.audio_hex;
    if (h && typeof h === 'string') {
        return new Blob([new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)))], { type: 'audio/mpeg' });
    }
    throw new Error('API返回格式无法识别');
}

async function pollTaskResult(baseUrl, headers, taskId) {
    const MAX = 60, INT = 2000;
    const urls = [
        baseUrl + '/' + taskId,
        baseUrl + '?task_id=' + taskId,];
    for (let i = 0; i < MAX; i++) {
        await new Promise(r => setTimeout(r, INT));
        for (const pu of (i === 0 ? urls : [urls[0]])) {
            try {
                let r = await fetch(pu, { method: 'GET', headers });
                if (r.status === 405|| r.status === 404) {
                    r = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify({ task_id: taskId }) });
                }
                if (!r.ok) continue;
                const ct = (r.headers.get('content-type') || '').toLowerCase();
                if (ct.includes('audio/') || ct.includes('octet-stream')) return await r.blob();
                const d = await r.json();
                console.log('[MiniMax TTS] 轮询#' + (i + 1) + ':', JSON.stringify(d).slice(0, 300));
                const st = (d.status || d.data?.status || '').toLowerCase();
                if (st === 'error' || st === 'failed') throw new Error(d.message || d.error || '任务失败');
                if (['completed', 'done', 'success', 'finished'].includes(st)) return await extractAudioFromResponse(d, 'mp3');
                if (getAudioFieldFromResponse(d)) return await extractAudioFromResponse(d, 'mp3');
                if (i === 0) { urls.length = 0; urls.push(pu); }
                break;
            } catch (e) { if (e.message.includes('任务失败')) throw e; }
        }
    }
    throw new Error('任务超时');
}

async function directMinimaxTts(text, options) {
    const set = s(), apiKey = (set.apiKey || '').trim();
    if (!apiKey) throw new Error('请先填写API Key');

    let url, isRelay = false;
    const apiHost = (set.apiHost || DEFAULT_API_HOST).replace(/\/+$/, '');

    if (apiHost === 'custom') {
        const ch = (set.customApiHost || '').trim().replace(/\/+$/, '');
        if (!ch) throw new Error('请填写中转地址');
        url = ch; isRelay = true;
    } else {
        url = apiHost + '/v1/t2a_v2?GroupId=' + encodeURIComponent((set.groupId || '').trim());}

    const voiceId = options.voiceId || set.voiceId;
    const speed = Number(options.speed ?? set.speed);
    const vol = Number(options.vol ?? set.vol);
    const pitch = Number(options.pitch ?? set.pitch);
    const emotion = options.emotion || set.emotion || '';
    const lang = options.language || set.ttsLanguage || '';
    const fmt = options.audioFormat || set.audioFormat || 'mp3';
    const model = options.model || set.model;

    const body = {
        model: model,
        text: text,
        stream: false,
        voice_setting: {
            voice_id: voiceId,
            speed: speed,
            vol: vol,
            pitch: pitch,
        },
        audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: fmt,
            channel: 1,
        },
    };

    if (emotion) body.voice_setting.emotion = emotion;
    if (lang) body.language_boost = lang;

    console.log('[MiniMax TTS] ===== 请求开始 =====');
    console.log('[MiniMax TTS] URL:', url);
    console.log('[MiniMax TTS] model:', model,'voice:', voiceId);
    console.log('[MiniMax TTS] body:', JSON.stringify(body, null, 2));

    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };
    const res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });

    console.log('[MiniMax TTS] HTTP状态:', res.status);
    console.log('[MiniMax TTS] Content-Type:', res.headers.get('content-type'));

    if (!res.ok) {
        let msg = 'HTTP' + res.status;
        try {
            const raw = await res.text();
            console.log('[MiniMax TTS] 错误响应:', raw);
            try {
                const e = JSON.parse(raw);
                msg = e.base_resp?.status_msg || e.error?.message || (typeof e.error === 'string' ? e.error : null) || e.message || e.detail || raw.slice(0, 200);
            } catch (_) { msg = raw.slice(0, 200); }
        } catch (_) {}
        throw new Error(msg);
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('audio/') || ct.includes('octet-stream')) {
        console.log('[MiniMax TTS] 直接返回音频流');
        return await res.blob();
    }

    const raw = await res.text();
    console.log('[MiniMax TTS] 响应原文:', raw.slice(0, 500));

    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error('响应不是有效JSON'); }

    if (data.status === 'error') {
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || data.message || 'API错误');
    }
    if (data.base_resp?.status_code !== 0&& data.base_resp?.status_code !== undefined) {
        throw new Error(data.base_resp?.status_msg || 'API错误');
    }

    const taskId = data.task_id || data.data?.task_id || data.id || data.data?.id;
    if (taskId && !getAudioFieldFromResponse(data)) {
        console.log('[MiniMax TTS] 异步任务:', taskId);
        return await pollTaskResult(url, headers, taskId);
    }

    return await extractAudioFromResponse(data, fmt);
}

async function getAudioBlob(item) {
    const ck = 'tts_' + simpleHash(item.text) + '_' + simpleHash(JSON.stringify(item.options));
    if (localAudioCache.has(ck)) return localAudioCache.get(ck);
    if (item.serverPath) {
        const r = await fetch(item.serverPath, { headers: getRequestHeaders() });
        if (r.ok) { const b = await r.blob(); localAudioCache.set(ck, b); return b; }
    }
    let blob;
    try {
        const r = await fetch(PROXY_ENDPOINT, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: item.text, apiHost: s().apiHost,
                model: item.options.model, voiceId: item.options.voiceId,
                speed: item.options.speed, volume: item.options.vol,
                pitch: item.options.pitch, format: item.options.audioFormat,
                emotion: item.options.emotion, language: item.options.language || undefined,
            }),
        });
        if (r.status === 404|| r.status === 501|| r.status === 405) throw new Error('NO_PROXY');
        if (!r.ok) {
            let m = 'HTTP' + r.status;
            try { const e = await r.json(); m = e.error || e.message || m; } catch (_) {}
            throw new Error(m);
        }
        blob = await r.blob();
    } catch (pe) {
        console.warn('[MiniMax] 代理失败,直连:', pe.message);
        blob = await directMinimaxTts(item.text, item.options);
    }
    localAudioCache.set(ck, blob);
    uploadToSTServer(blob, ck + '.' + item.options.audioFormat).then(p => {
        if (p) { item.serverPath = p; saveSettingsDebounced(); }
    });
    return blob;
}

async function playNext() {
    if (!playbackQueue.length) { isPlaying = false; return; }
    isPlaying = true;
    const item = playbackQueue.shift();
    if (item.pauseMs) { await new Promise(r => setTimeout(r, item.pauseMs)); playNext(); return; }
    try {
        const b = await getAudioBlob(item);
        const u = URL.createObjectURL(b);
        activeAudio.src = u;
        activeAudio.onended = function () { URL.revokeObjectURL(u); playNext(); };
        activeAudio.onerror = function () { URL.revokeObjectURL(u); playNext(); };
        await activeAudio.play();
    } catch (e) { console.error('[MiniMax TTS]', e); playNext(); }
}

function applyPreProcessRules(text) {
    const rules = (s().llmPreProcessRules || []).filter(function (r) { return r.enabled && r.pattern; });
    if (!rules.length) return text;
    for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        var re;
        try { re = new RegExp(parsePattern(rule.pattern), 'gs'); } catch (_) { continue; }
        if (rule.mode === 'extract') {
            var matches = [], x;
            while ((x = re.exec(text)) !== null) { var t = (x[1] !== undefined ? x[1] : x[0]).trim(); if (t) matches.push(t); }
            if (matches.length) text = matches.join('\n');
        } else { text = text.replace(re, ''); }
    }
    return text.trim();
}

async function formatWithSecondaryApi(m) {
    var set = s(), preset = (set.llmPresets || [])[set.formatterPresetIdx];
    if (!preset) throw new Error('请先选择LLM预设');
    var fmt = preset.format || API_FORMATS.OAI, prompt = set.formatterSystemPrompt;
    var text;
    if (fmt === API_FORMATS.OAI) {
        var d = await proxyFetch(normalizeOaiUrl(preset.url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (preset.key || '').trim() },
            body: { model: preset.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: applyPreProcessRules(m.mes) }], temperature: 0.1 },
        });
        text = d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    } else {
        var bu = (preset.url || '').trim().replace(/\/+$/, '');
        var d2 = await proxyFetch(bu + '/v1beta/models/' + preset.model + ':generateContent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': (preset.key || '').trim() },
            body: { contents: [{ role: 'user', parts: [{ text: 'System Prompt: ' + prompt + '\n\nUser Message: ' + applyPreProcessRules(m.mes) }] }] },
        });
        text = d2.candidates && d2.candidates[0] ? d2.candidates[0].content.parts[0].text : '';
    }
    var match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI无有效JSON');
    return JSON.parse(match[0]).segments || null;
}

function findCharacterBinding(name) {
    if (!name) return null;
    var set = s(), ctx = getContext(), n = name.toLowerCase();
    var id = ctx.characterId || ctx.character_id || ctx.name2|| 'global';
    var bindings = set.characterBindingsMap[id] || [];
    for (var i = 0; i < bindings.length; i++) {
        var b = bindings[i];
        var bn = (b.targetType === TARGET_TYPE.CUSTOM ? b.customName : (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 : ctx.name1));
        if (bn && bn.toLowerCase() === n) return b;
    }
    return null;
}

function buildSynthesisOptions(seg, m) {
    var set = s(), b = findCharacterBinding(seg ? seg.speaker : (m ? m.name : ''));
    return {
        model: (seg && seg.model) || (b && b.model) || set.model,
        voiceId: (seg && seg.voiceId) || (b && b.voiceId) || set.voiceId,
        speed: Number((seg && seg.speed != null) ? seg.speed : set.speed),
        vol: Number((seg && seg.vol != null) ? seg.vol : (set.vol != null ? set.vol : 1)),
        pitch: Number((seg && seg.pitch != null) ? seg.pitch : (set.pitch != null ? set.pitch : 0)),
        emotion: (seg && seg.emotion) || set.emotion || undefined,
        audioFormat: set.audioFormat || 'mp3',
        language: set.ttsLanguage || undefined,
    };
}

function runRegexExtraction(cleanText, rules, speaker) {
    var extracted = [];
    var i, rule, fl, re, qm;
    for (i = 0; i < rules.length; i++) {
        rule = rules[i];
        if (rule.mode !== 'extract') continue;
        fl = (rule.flags || 'g');
        if (fl.indexOf('g') === -1) fl += 'g';
        try { re = new RegExp(parsePattern(rule.pattern), fl); } catch (_) { continue; }
        while ((qm = re.exec(cleanText)) !== null) {
            var inner = (qm[1] || '').replace(/\n+/g, ' ').trim();
            var full = (qm[0] || '').replace(/\n+/g, ' ').trim();
            if (inner && inner.length >= 2) {
                extracted.push({ text: inner, fullMatch: full, speaker: speaker });
            }
        }
    }
    for (i = 0; i < rules.length; i++) {
        rule = rules[i];
        if (rule.mode !== 'exclude') continue;
        fl = (rule.flags || 'g');
        if (fl.indexOf('g') === -1) fl += 'g';
        try { re = new RegExp(parsePattern(rule.pattern), fl); } catch (_) { continue; }
        extracted = extracted.filter(function (seg) { return !re.test(seg.text); });
    }
    return extracted;
}

async function generateMessageSpeech(id, forced) {
    var data = getMessageData(id);
    var message = data.message, key = data.key;
    if (!message || (s().onlyCharacter && message.is_user)) return false;
    if (isHtmlMessage(message.mes)) return false;
    var h = s().serverHistory[key];
    if (!forced && h && h.versions && h.versions.length) return true;
    try {
        var raw;
        if (s().formatterEnabled) {
            raw = await formatWithSecondaryApi(message);
        } else {
            var ct = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
            var rules = (s().regexRules || []).filter(function (r) { return r.enabled; });
            raw = rules.length ? runRegexExtraction(ct, rules, message.name) : [];
        }
        var items = raw.map(function (seg) {
            return {
                text: seg.text,
                fullMatch: seg.fullMatch || '',
                speaker: seg.speaker || message.name,
                options: buildSynthesisOptions(seg, message),
                serverPath: null,
            };
        });
        if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
        s().serverHistory[key].versions.push({ items: items, timestamp: Date.now() });
        s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
        saveSettingsDebounced();
        refreshAllMessageButtons();
        injectBubbles(id);
        return true;
    } catch (e) { toastr.error('生成失败:' + e.message); return false; }
}

function extractSegmentsOnly(id) {
    if (!s().showBubbles) return false;
    var data = getMessageData(id);
    var message = data.message, key = data.key;
    if (!message || message.is_system || (s().onlyCharacter && message.is_user)) return false;
    if (s().serverHistory[key] && s().serverHistory[key].versions && s().serverHistory[key].versions.length) return true;
    if (isHtmlMessage(message.mes)) return false;
    if (s().formatterEnabled) return false;
    var ct = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
    var rules = (s().regexRules || []).filter(function (r) { return r.enabled; });
    if (!rules.length) return false;
    var extracted = runRegexExtraction(ct, rules, message.name);
    if (!extracted.length) return false;
    var items = extracted.map(function (seg) {
        return {
            text: seg.text,
            fullMatch: seg.fullMatch || '',
            speaker: seg.speaker || message.name,
            options: buildSynthesisOptions(seg, message),
            serverPath: null,
        };
    });
    if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
    s().serverHistory[key].versions.push({ items: items, timestamp: Date.now() });
    s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
    saveSettingsDebounced();
    return true;
}

async function playGeneratedMessage(id) {
    var data = getMessageData(id);
    var h = s().serverHistory[data.key];
    if (!h || !h.versions[h.activeIndex]) return false;
    playbackQueue = h.versions[h.activeIndex].items.slice();
    activeAudio.pause(); activeAudio.src = '';
    if (!isPlaying) playNext();
    setTimeout(function () { saveSettingsDebounced(); }, 2000);
    return true;
}

function isBubbleCached(item) {
    if (!item || item.pauseMs) return false;
    if (item.serverPath) return true;
    return localAudioCache.has('tts_' + simpleHash(item.text) + '_' + simpleHash(JSON.stringify(item.options)));
}

function refreshBubbleStates(mesid) {
    var data = getMessageData(mesid);
    var h = s().serverHistory[data.key];
    var items = (h && h.versions && h.versions[h.activeIndex]) ? h.versions[h.activeIndex].items : [];
    var el = document.querySelector('#chat .mes[mesid="' + mesid + '"]');
    if (!el) return;
    el.querySelectorAll('.mm-bubble').forEach(function (b) {
        var it = items[Number(b.dataset.segidx)];
        if (it) b.classList.toggle('mm-bubble-cached', isBubbleCached(it));
    });
}

function refreshAllMessageButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(function (el) {
        var id = el.getAttribute('mesid');
        var data = getMessageData(id);
        if (!data.message || data.message.is_system || isHtmlMessage(data.message.mes)) return;
        var extra = el.querySelector('.extraMesButtons'); if (!extra) return;
        var btn = el.querySelector('.mes_quote_tts');
        if (!btn) {
            btn = document.createElement('div');
            btn.className = 'mes_button mes_quote_tts fa-solid fa-volume-high';
            extra.appendChild(btn);
        }
        var h = s().serverHistory[data.key];
        var ready = false;
        if (s().showBubbles && h && h.versions && h.versions[h.activeIndex] && h.versions[h.activeIndex].items.length > 0) {
            ready = h.versions[h.activeIndex].items.filter(function (it) { return !it.pauseMs && it.text; }).every(isBubbleCached);
        } else {
            ready = !!(h && h.versions && h.versions.length > 0);
        }
        btn.classList.toggle('ready', ready);
    });
}

function makeBubble(mesid, segidx, item, withText) {
    var el = document.createElement('span');
    el.className = 'mm-bubble';
    el.dataset.mesid = mesid;
    el.dataset.segidx = segidx;
    el.title = item.text;
    var label = item.text.length > 20 ? item.text.slice(0, 20) + '' : item.text;
    el.innerHTML = withText
        ? '<i class="fa-solid fa-volume-low"></i>' + escHtml(label)
        : '<i class="fa-solid fa-volume-low"></i>';
    if (isBubbleCached(item)) el.classList.add('mm-bubble-cached');
    return el;
}

function injectAfterText(container, searchText, insertEl) {
    if (!searchText) return false;
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
            return n.parentElement.closest('.mm-bubble,.mm-bubble-strip')
                ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
    });
    var node;
    while ((node = walker.nextNode())) {
        var idx = node.textContent.indexOf(searchText);
        if (idx < 0) continue;
        var end = idx + searchText.length;
        var after = node.textContent.slice(end);
        node.textContent = node.textContent.slice(0, end);
        var p = node.parentNode, nx = node.nextSibling;
        p.insertBefore(insertEl, nx);
        if (after) p.insertBefore(document.createTextNode(after), insertEl.nextSibling);
        return true;
    }
    return false;
}

function injectBubbles(mesid) {
    if (!s().showBubbles) return;
    if (document.getElementById('minimax_quote_tts_editor')) return;

    var data = getMessageData(mesid);
    var message = data.message, key = data.key;
    if (!message || message.is_system) return;

    var mesEl = document.querySelector('#chat .mes[mesid="' + mesid + '"]');
    if (!mesEl) return;
    var textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return;

    //先清理旧气泡
    textEl.querySelectorAll('.mm-bubble').forEach(function (e) { e.remove(); });
    var oldStrip = textEl.querySelector('.mm-bubble-strip');
    if (oldStrip) oldStrip.remove();
    delete textEl.dataset.mmBubVer;

    // HTML消息跳过
    if (isHtmlMessage(message.mes)) {
        if (s().serverHistory[key]) {
            delete s().serverHistory[key];
            saveSettingsDebounced();
        }
        return;
    }

    if (s().formatterEnabled) return;

    var h = s().serverHistory[key];
    var allItems = (h && h.versions && h.versions[h.activeIndex]) ? h.versions[h.activeIndex].items : [];
    var items = [];
    for (var i = 0; i < allItems.length; i++) {
        if (!allItems[i].pauseMs && allItems[i].text) {
            items.push({ it: allItems[i], idx: i });
        }
    }
    if (!items.length) return;

    //旧数据没fullMatch就清掉
    var hasOld = false;
    for (var j = 0; j < items.length; j++) {
        if (!items[j].it.fullMatch) { hasOld = true; break; }
    }
    if (hasOld) {
        delete s().serverHistory[key];
        saveSettingsDebounced();return;
    }

    var isQuoteMode = (s().regexRules || []).some(function (r) { return r.enabled && r.mode === 'extract'; });
    if (!isQuoteMode) return;

    // 只在引号后面插入气泡
    for (var k = 0; k < items.length; k++) {
        var item = items[k].it;
        if (!item.fullMatch) continue;
        var bubble = makeBubble(mesid, items[k].idx, item, false);
        injectAfterText(textEl, item.fullMatch, bubble);
    }

    textEl.dataset.mmBubVer = key + ':' + (h ? h.activeIndex : 0) + ':' + items.length;
}

function refreshAllBubbles() {
    removeAllBubbles();
    if (!s().showBubbles) return;
    document.querySelectorAll('#chat .mes[mesid]').forEach(function (el) {
        var id = Number(el.getAttribute('mesid'));
        extractSegmentsOnly(id);injectBubbles(id);
    });
}

function removeAllBubbles() {
    document.querySelectorAll('.mm-bubble,.mm-bubble-strip').forEach(function (e) { e.remove(); });document.querySelectorAll('[data-mm-bub-ver]').forEach(function (e) { e.removeAttribute('data-mm-bub-ver'); });
}

function openParamsEditor(id) {
    var data = getMessageData(id);
    var h = s().serverHistory[data.key];
    if (!h || !h.versions || !h.versions.length) return;

    function render() {
        var v = h.versions[h.activeIndex];
        var rows = '';
        for (var i = 0; i < v.items.length; i++) {
            var it = v.items[i];
            rows += '<div class="minimax-tts-editor-item">'
                + '<div style="font-size:0.8rem;opacity:0.6;margin-bottom:4px">说话人:'
                + '<input class="edit-v" data-prop="speaker" data-idx="' + i + '" value="' + escHtml(it.speaker || '') + '" style="width:100px;height:20px!important;display:inline-block;border:none!important;background:none!important;color:inherit!important;padding:0!important">'
                + '</div>'
                + '<textarea class="text_pole" readonly style="width:100%;height:40px;margin-bottom:8px;background:rgba(0,0,0,0.2)!important">' + escHtml(it.text) + '</textarea>'
                + '<div class="minimax-tts-editor-grid">'
                + '<div class="minimax-tts-editor-row-flex"><label>模型</label><select class="text_pole edit-v" data-prop="model" data-idx="' + i + '">' + MODEL_OPTIONS.map(function (o) { return '<option value="' + o.value + '">' + o.label + '</option>'; }).join('') + '</select></div>'
                + '<div class="minimax-tts-editor-row-flex"><label>语音</label><input class="text_pole edit-v" data-prop="voiceId" data-idx="' + i + '" value="' + escHtml(it.options.voiceId) + '"></div>'
                + '<div class="minimax-tts-editor-row-flex"><label>情感</label><input class="text_pole edit-v" data-prop="emotion" data-idx="' + i + '" value="' + escHtml(it.options.emotion || '') + '"></div>'
                + '<div class="minimax-tts-editor-row-flex"><label>语速</label><input class="text_pole edit-v" data-prop="speed" type="number" step="0.1" data-idx="' + i + '" value="' + it.options.speed + '"></div>'
                + '<div class="minimax-tts-editor-row-flex"><label>音量</label><input class="text_pole edit-v" data-prop="vol" type="number" step="0.1" data-idx="' + i + '" value="' + it.options.vol + '"></div>'
                + '<div class="minimax-tts-editor-row-flex"><label>音调</label><input class="text_pole edit-v" data-prop="pitch" type="number" step="1" data-idx="' + i + '" value="' + it.options.pitch + '"></div>'
                + '</div></div>';
        }
        var html = '<div id="minimax_quote_tts_editor" class="minimax-tts-editor-mask"><div class="minimax-tts-editor-dialog">'
            + '<div class="minimax-tts-editor-header">'
            + '<div style="font-weight:bold;font-size:1.1rem;flex:1">版本 ' + (h.activeIndex + 1) + '/' + h.versions.length + '</div>'
            + '<div style="display:flex;gap:10px;align-items:center;flex:1"><button class="menu_button v-prev" style="width:40px">&lt;</button><button class="menu_button v-next" style="width:40px">&gt;</button><button class="menu_button v-del" style="color:#ef5350">删除</button></div>'
            + '<div style="text-align:right"><button class="menu_button editor-close">关闭</button></div>'
            + '</div>'
            + '<div class="minimax-tts-editor-body">' + rows + '</div>'
            + '<div class="minimax-tts-editor-actions"><button class="menu_button editor-save-only" style="height:40px">保存修改</button><button class="menu_button editor-confirm" style="height:40px">确认选择此版本</button></div>'
            + '</div></div>';

        $('#minimax_quote_tts_editor').remove();
        $('body').append(html);

        $('#minimax_quote_tts_editor .v-prev').on('click', function () { if (h.activeIndex > 0) { h.activeIndex--; render(); } });
        $('#minimax_quote_tts_editor .v-next').on('click', function () { if (h.activeIndex < h.versions.length - 1) { h.activeIndex++; render(); } });
        $('#minimax_quote_tts_editor .v-del').on('click', function () {
            if (h.versions.length <= 1) { delete s().serverHistory[data.key]; saveSettingsDebounced(); refreshAllMessageButtons(); $('#minimax_quote_tts_editor').remove(); return; }
            h.versions.splice(h.activeIndex, 1);
            h.activeIndex = Math.min(h.activeIndex, h.versions.length - 1);
            saveSettingsDebounced(); refreshAllMessageButtons(); render();
        });
        var inv = function () {
            var te = document.querySelector('#chat .mes[mesid="' + id + '"] .mes_text');
            if (te) te.removeAttribute('data-mm-bub-ver');setTimeout(function () { injectBubbles(id); refreshBubbleStates(id); refreshAllMessageButtons(); }, 100);
        };
        $('#minimax_quote_tts_editor .editor-close').on('click', function () { $('#minimax_quote_tts_editor').remove(); inv(); });
        $('#minimax_quote_tts_editor .edit-v').on('change input', function () {
            var p = $(this).data('prop'), idx = $(this).data('idx'), val = $(this).val();
            if (p === 'speaker') { v.items[idx].speaker = val; var b = findCharacterBinding(val); if (b) { v.items[idx].options.model = b.model || s().model; v.items[idx].options.voiceId = b.voiceId || s().voiceId; render(); } }
            else { v.items[idx].options[p] = val; }
            v.items[idx].serverPath = null;
        });
        $('#minimax_quote_tts_editor .editor-save-only').on('click', function () { saveSettingsDebounced(); toastr.success('已保存'); });
        $('#minimax_quote_tts_editor .editor-confirm').on('click', function () { saveSettingsDebounced(); $('#minimax_quote_tts_editor').remove(); refreshAllMessageButtons(); inv(); });
        $('#minimax_quote_tts_editor select.edit-v').each(function () { $(this).val(v.items[$(this).data('idx')].options.model); });
    }
    render();
}

function refreshAllLlmPresetSelects() {
    var ps = s().llmPresets || [];
    var opts = '<option value="-1">--选择预设--</option>';
    for (var i = 0; i < ps.length; i++) opts += '<option value="' + i + '">' + escHtml(ps[i].name) + '</option>';
    document.querySelectorAll('.llm-preset-sel').forEach(function (el) {
        var c = el.value; el.innerHTML = opts;
        if (Number(c) >= 0 && Number(c) < ps.length) el.value = c;
    });
}

function loadLlmPresetFieldsGlobal(i) {
    var p = (s().llmPresets || [])[i]; if (!p) return;
    document.getElementById('mm_llm_url').value = p.url || '';
    document.getElementById('mm_llm_key').value = p.key || '';
    document.getElementById('mm_llm_format').value = p.format || API_FORMATS.OAI;
    document.getElementById('mm_llm_model').value = p.model || '';
    document.getElementById('mm_llm_model').style.display = '';
    document.getElementById('mm_llm_model_sel').style.display = 'none';
}

function injectStyles() {
    if (document.getElementById('mm-tts-css')) return;
    var st = document.createElement('style');
    st.id = 'mm-tts-css';
    st.textContent = '.mm-config-mask{display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);justify-content:center;align-items:center;padding:16px}.mm-config-mask.mm-config-open{display:flex!important}.mm-config-dialog{width:min(680px,96vw);max-height:92vh;background:var(--SmartThemeBlurTintColor,#1a1c2a);color:var(--SmartThemeBodyColor,#ccc);border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}.mm-config-header{display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;gap:8px}.mm-config-close{background:none;border:none;color:inherit;font-size:1.2rem;cursor:pointer;padding:4px 8px;opacity:.6;flex-shrink:0}.mm-config-close:hover{opacity:1}.mm-config-body{flex:1;overflow-y:auto;padding:16px}.mm-tab-bar{display:flex;gap:2px;flex:1;flex-wrap:wrap}.mm-tab{background:transparent;border:none;color:inherit;padding:6px 14px;cursor:pointer;border-radius:8px 8px 0 0;font-size:.88rem;opacity:.55;white-space:nowrap}.mm-tab:hover{opacity:.8;background:rgba(255,255,255,.04)}.mm-tab.active{opacity:1;background:rgba(255,255,255,.08);font-weight:600}.mm-tab-panel{display:none}.mm-tab-panel.active{display:block}.mm-config-dialog .mm-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}.mm-config-dialog .mm-row>label{min-width:85px;flex-shrink:0;font-size:.88rem;opacity:.8}.mm-config-dialog .text_pole{flex:1;min-width:0;max-width:100%;box-sizing:border-box;height:34px!important;font-size:.88rem!important}.mm-config-dialog textarea.text_pole{height:auto!important;min-height:64px;resize:vertical}.mm-config-dialog select.text_pole{flex:1;min-width:0}.mm-config-dialog input[type=checkbox]{flex:none;width:18px;height:18px}.mm-section-title{font-weight:600;font-size:.95rem;margin:16px 0 8px;display:flex;align-items:center;gap:10px}.mm-desc{font-size:.82rem;opacity:.55;margin:0 0 10px;line-height:1.4}.mm-inline-hint{font-size:.78rem;opacity:.5;white-space:nowrap}.mm-voice-lib-row,.mm-binding-row{display:flex;gap:6px;margin-bottom:6px;align-items:center}.mm-binding-row{flex-wrap:wrap}.mm-binding-row .text_pole{flex:1;min-width:80px}.mm-rule-header-row{display:flex;gap:6px;font-size:.78rem;opacity:.5;padding:0 0 4px}.mm-rule-header-row>span{flex:1}.mm-rule-row{display:flex;gap:6px;margin-bottom:6px;align-items:center}.mm-rule-row .text_pole{flex:1;min-width:0}.mes_quote_tts{cursor:pointer;opacity:.5}.mes_quote_tts:hover{opacity:.85}.mes_quote_tts.ready{opacity:1;color:#4caf50}.mm-bubble{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;margin:0 2px;border-radius:10px;background:rgba(110,160,255,.12);cursor:pointer;font-size:.78rem;vertical-align:middle;transition:background .15s;white-space:nowrap}.mm-bubble:hover{background:rgba(110,160,255,.25)}.mm-bubble i{font-size:.7rem}.mm-bubble-cached{background:rgba(76,175,80,.15)}.mm-bubble-cached:hover{background:rgba(76,175,80,.3)}.mm-bubble-loading{opacity:.5;pointer-events:none}.mm-bubble-playing{background:rgba(255,165,0,.2)}.mm-bubble-strip{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.1)}.minimax-tts-editor-mask{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.6);display:flex;justify-content:center;align-items:center;padding:16px}.minimax-tts-editor-dialog{width:min(600px,94vw);max-height:88vh;background:var(--SmartThemeBlurTintColor,#1a1c2a);color:var(--SmartThemeBodyColor,#ccc);border-radius:16px;display:flex;flex-direction:column;overflow:hidden}.minimax-tts-editor-header{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);gap:8px}.minimax-tts-editor-body{flex:1;overflow-y:auto;padding:16px}.minimax-tts-editor-item{margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,.05)}.minimax-tts-editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.minimax-tts-editor-row-flex{display:flex;align-items:center;gap:6px}.minimax-tts-editor-row-flex label{min-width:36px;font-size:.82rem;opacity:.7}.minimax-tts-editor-actions{display:flex;gap:10px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08)}.minimax-tts-editor-actions .menu_button{flex:1}';
    document.head.appendChild(st);
}

function renderVoiceLibrary() {
    var c = document.getElementById('mm_voice_lib_rows'); if (!c) return; c.innerHTML = '';
    (s().voiceLibrary || []).forEach(function (v, i) {
        var el = document.createElement('div'); el.className = 'mm-voice-lib-row';
        el.innerHTML = '<input class="text_pole vl-name" placeholder="名称" value="' + escHtml(v.name || '') + '"><input class="text_pole vl-id" placeholder="voiceId" value="' + escHtml(v.voiceId || '') + '"><button class="menu_button vl-del" style="padding:4px 10px;flex-shrink:0">×</button>';
        el.querySelector('.vl-name').addEventListener('input', function () { s().voiceLibrary[i].name = this.value; saveSettingsDebounced(); refreshVoiceSelects(); });
        el.querySelector('.vl-id').addEventListener('input', function () { s().voiceLibrary[i].voiceId = this.value; saveSettingsDebounced(); });
        el.querySelector('.vl-del').addEventListener('click', function () { s().voiceLibrary.splice(i, 1); saveSettingsDebounced(); renderVoiceLibrary(); refreshVoiceSelects(); });
        c.appendChild(el);
    });
}

function refreshVoiceSelects() {
    var lib = s().voiceLibrary || [];
    var opts = '<option value="">直接输入</option>';
    for (var i = 0; i < lib.length; i++) opts += '<option value="' + escHtml(lib[i].voiceId) + '">' + escHtml(lib[i].name) + '</option>';
    document.querySelectorAll('.mm-voice-sel').forEach(function (el) { var c = el.value; el.innerHTML = opts; if (c) { for (var j = 0; j < el.options.length; j++) { if (el.options[j].value === c) { el.value = c; break; } } } });
}

function renderRules() {
    var c = document.getElementById('mm_rule_rows'); if (!c) return; c.innerHTML = '';
    (s().regexRules || []).forEach(function (r, i) {
        var el = document.createElement('div'); el.className = 'mm-rule-row';
        el.innerHTML = '<input type="checkbox" class="mm-rule-toggle" ' + (r.enabled ? 'checked' : '') + '><input class="text_pole mm-rule-name" placeholder="规则名" value="' + escHtml(r.name || '') + '"><input class="text_pole mm-rule-pattern" placeholder="正则" value="' + escHtml(r.pattern || '') + '"><select class="text_pole mm-rule-mode" style="max-width:68px"><option value="extract" ' + (r.mode === 'extract' ? 'selected' : '') + '>提取</option><option value="exclude" ' + (r.mode === 'exclude' ? 'selected' : '') + '>排除</option></select><button class="menu_button mm-rule-del">×</button>';
        el.querySelector('.mm-rule-toggle').addEventListener('change', function () { s().regexRules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input', function () { s().regexRules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function () { s().regexRules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change', function () { s().regexRules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click', function () { s().regexRules.splice(i, 1); saveSettingsDebounced(); renderRules(); });
        c.appendChild(el);
    });
}

function renderPreProcessRules() {
    var c = document.getElementById('mm_pre_rule_rows'); if (!c) return; c.innerHTML = '';
    (s().llmPreProcessRules || []).forEach(function (r, i) {
        var el = document.createElement('div'); el.className = 'mm-rule-row';
        el.innerHTML = '<input type="checkbox" class="mm-rule-toggle" ' + (r.enabled ? 'checked' : '') + '><input class="text_pole mm-rule-name" placeholder="规则名" value="' + escHtml(r.name || '') + '"><input class="text_pole mm-rule-pattern" placeholder="正则" value="' + escHtml(r.pattern || '') + '"><select class="text_pole mm-rule-mode" style="max-width:68px"><option value="extract" ' + (r.mode === 'extract' ? 'selected' : '') + '>提取</option><option value="exclude" ' + (r.mode === 'exclude' ? 'selected' : '') + '>排除</option></select><button class="menu_button mm-rule-del">×</button>';
        el.querySelector('.mm-rule-toggle').addEventListener('change', function () { s().llmPreProcessRules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input', function () { s().llmPreProcessRules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function () { s().llmPreProcessRules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change', function () { s().llmPreProcessRules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click', function () { s().llmPreProcessRules.splice(i, 1); saveSettingsDebounced(); renderPreProcessRules(); });
        c.appendChild(el);
    });
}

function renderBindings() {
    var c = getContext(), cid = c.characterId || c.character_id || c.name2 || 'global';
    if (!s().characterBindingsMap[cid]) s().characterBindingsMap[cid] = [];
    var ct = $('#mm_b_rows'); if (!ct.length) return; ct.empty();
    var lib = s().voiceLibrary || [];
    s().characterBindingsMap[cid].forEach(function (b, i) {
        var vo = '<option value="">直接输入</option>';
        for (var j = 0; j < lib.length; j++) vo += '<option value="' + escHtml(lib[j].voiceId) + '">' + escHtml(lib[j].name) + '</option>';
        var lm = null;
        for (var k = 0; k < lib.length; k++) { if (lib[k].voiceId === b.voiceId) { lm = lib[k]; break; } }
        var row = $('<div class="mm-binding-row">'
            + '<select class="text_pole b-type"><option value="' + TARGET_TYPE.CURRENT_CHARACTER + '">' + escHtml(c.name2|| '角色') + '</option><option value="' + TARGET_TYPE.CURRENT_USER + '">' + escHtml(c.name1 || '你') + '</option><option value="' + TARGET_TYPE.CUSTOM + '">自定义</option></select>'
            + '<input class="text_pole b-name" placeholder="名称" value="' + escHtml(b.customName || '') + '" style="' + (b.targetType === TARGET_TYPE.CUSTOM ? '' : 'display:none') + '">'
            + '<select class="text_pole b-model">' + MODEL_OPTIONS.map(function (o) { return '<option value="' + o.value + '">' + o.label + '</option>'; }).join('') + '</select>'
            + '<select class="text_pole b-voice-lib mm-voice-sel">' + vo + '</select>'
            + '<input class="text_pole b-voice" placeholder="voiceId" value="' + escHtml(lm ? '' : b.voiceId || '') + '" style="' + (lm ? 'display:none' : '') + '">'
            + '<button class="menu_button b-del" style="padding:4px 10px;flex-shrink:0">×</button>'
            + '</div>');
        row.find('.b-type').val(b.targetType).on('change', function () { b.targetType = $(this).val(); renderBindings(); saveSettingsDebounced(); });
        row.find('.b-name').on('input', function () { b.customName = $(this).val(); saveSettingsDebounced(); });
        row.find('.b-model').val(b.model || s().model).on('change', function () { b.model = $(this).val(); saveSettingsDebounced(); });
        row.find('.b-voice-lib').val(lm ? b.voiceId : '').on('change', function () { var v2 = $(this).val(); b.voiceId = v2; row.find('.b-voice').toggle(!v2).val(''); saveSettingsDebounced(); });
        row.find('.b-voice').on('input', function () { b.voiceId = $(this).val(); saveSettingsDebounced(); });
        row.find('.b-del').on('click', function () { s().characterBindingsMap[cid].splice(i, 1); renderBindings(); saveSettingsDebounced(); });
        ct.append(row);
    });
}

function renderRegexPresets() {
    var sel = document.getElementById('mm_regex_presets'); if (!sel) return;
    sel.innerHTML = '<option value="-1">--选择预设--</option>';
    (s().regexPresets || []).forEach(function (p, i) { var o = document.createElement('option'); o.value = i; o.textContent = p.name; sel.appendChild(o); });
}

function populateConfigFields() {
    var set = s();
    var el = function (id) { return document.getElementById(id); };
    if (!el('mm_key')) return;
    el('mm_key').value = set.apiKey || '';
    el('mm_gid').value = set.groupId || '';
    el('mm_apihost').value = set.apiHost || DEFAULT_API_HOST;
    el('mm_custom_host').value = set.customApiHost || '';
    el('mm_custom_host_row').style.display = set.apiHost ==='custom' ? '' : 'none';
    el('mm_model').value = set.model || 'Speech-2.8-hd';
    el('mm_speed').value = set.speed != null ? set.speed : 1;
    el('mm_vol').value = set.vol != null ? set.vol : 1;
    el('mm_tts_lang').value = set.ttsLanguage || '';
    el('mm_autoplay').checked = set.autoPlay !== false;
    el('mm_show_bubbles').checked = set.showBubbles || false;
    renderVoiceLibrary(); refreshVoiceSelects();
    var vs = el('mm_voice_sel'), vi = el('mm_voice');
    var lm = null;
    for (var i = 0; i < (set.voiceLibrary || []).length; i++) { if (set.voiceLibrary[i].voiceId === set.voiceId) { lm = set.voiceLibrary[i]; break; } }
    if (lm) { vs.value = set.voiceId; vi.style.display = 'none'; }
    else { vs.value = ''; vi.value = set.voiceId || ''; vi.style.display = ''; }
    el('mm_f_en').checked = set.formatterEnabled || false;
    el('mm_f_prompt').value = set.formatterSystemPrompt || '';
    refreshAllLlmPresetSelects();
    if ((s().llmPresets || []).length > 0) { el('mm_llm_presets').value = 0; loadLlmPresetFieldsGlobal(0); }
    if (set.formatterPresetIdx >= 0) el('mm_f_preset_sel').value = set.formatterPresetIdx;
    renderRules(); renderRegexPresets(); renderPreProcessRules(); renderBindings();
}

function openConfigPanel() {
    if (!document.getElementById('mm-config-mask')) {
        var hostOpts = '';
        for (var i = 0; i < API_HOST_OPTIONS.length; i++) hostOpts += '<option value="' + API_HOST_OPTIONS[i].value + '">' + API_HOST_OPTIONS[i].label + '</option>';
        var modelOpts = '';
        for (var j = 0; j < MODEL_OPTIONS.length; j++) modelOpts += '<option value="' + MODEL_OPTIONS[j].value + '">' + MODEL_OPTIONS[j].label + '</option>';

        var panelHtml = '<div id="mm-config-mask" class="mm-config-mask"><div class="mm-config-dialog">'
            + '<div class="mm-config-header"><div class="mm-tab-bar">'
            + '<button class="mm-tab active" data-tab="tts">TTS配置</button>'
            + '<button class="mm-tab" data-tab="llm">LLM预设</button>'
            + '<button class="mm-tab" data-tab="format">格式化</button>'
            + '</div><button class="mm-config-close">✕</button></div>'
            + '<div class="mm-config-body">'

            //─── TTS面板 ───
            + '<div class="mm-tab-panel active" data-panel="tts">'
            + '<p class="mm-desc">配置MiniMax TTS API连接参数及默认音色。</p>'
            + '<div class="mm-row"><label>API Key</label><input id="mm_key" class="text_pole" type="password" autocomplete="off"></div>'
            + '<div class="mm-row"><label>Group ID</label><input id="mm_gid" class="text_pole" type="text"></div>'
            + '<div class="mm-row"><label>API节点</label><select id="mm_apihost" class="text_pole">' + hostOpts + '</select></div>'
            + '<div class="mm-row" id="mm_custom_host_row" style="display:none"><label>中转地址</label><input id="mm_custom_host" class="text_pole" type="text" placeholder="https://tts.example.com/api/v1/tts"></div>'
            + '<div class="mm-row"><label>默认模型</label><select id="mm_model" class="text_pole">' + modelOpts + '</select></div>'
            + '<div class="mm-row"><label>默认语音</label><select id="mm_voice_sel" class="text_pole mm-voice-sel" style="flex:1"></select><input id="mm_voice" class="text_pole" placeholder="voiceId" style="max-width:160px"></div>'
            + '<div class="mm-row"><label>语速</label><input id="mm_speed" class="text_pole" type="number" step="0.1" min="0.5" max="2" style="max-width:80px"></div>'
            + '<div class="mm-row"><label>音量</label><input id="mm_vol" class="text_pole" type="number" step="0.1" min="0" max="10" style="max-width:80px"></div>'
            + '<div class="mm-row"><label>语言</label><select id="mm_tts_lang" class="text_pole"><option value="">自动</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="es">Español</option><option value="pt">Português</option><option value="id">Indonesia</option><option value="ar">العربية</option></select><span class="mm-inline-hint">克隆声音建议指定</span></div>'
            + '<div class="mm-row"><label>自动播放</label><input id="mm_autoplay" type="checkbox"></div>'
            + '<div class="mm-row"><label>语音气泡</label><input id="mm_show_bubbles" type="checkbox"><span class="mm-inline-hint">仅在引号对话后显示</span></div>'
            + '<div class="mm-row"><button id="mm_test_tts" class="menu_button"><i class="fa-solid fa-play"></i> 测试语音</button></div>'
            + '<div class="mm-section-title">语音库 <button id="mm_add_voice" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+添加</button></div>'
            + '<p class="mm-desc">为语音ID起名。</p>'
            + '<div id="mm_voice_lib_rows"></div>'
            + '<div class="mm-section-title" style="margin-top:16px">角色绑定 <button id="mm_add_b" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+添加</button></div>'
            + '<p class="mm-desc">为角色分配专属音色。</p>'
            + '<div id="mm_b_rows"></div>'
            + '</div>'

            // ─── LLM面板 ───
            + '<div class="mm-tab-panel" data-panel="llm">'
            + '<p class="mm-desc">管理用于格式化的LLM API预设。</p>'
            + '<div class="mm-row"><label>预设</label><select id="mm_llm_presets" class="text_pole llm-preset-sel"></select><button id="mm_llm_save_p" class="menu_button">保存</button><button id="mm_llm_upd_p" class="menu_button">更新</button><button id="mm_llm_del_p" class="menu_button">删除</button></div>'
            + '<div class="mm-row"><label>接口格式</label><select id="mm_llm_format" class="text_pole"><option value="' + API_FORMATS.OAI + '">OpenAI</option><option value="' + API_FORMATS.GOOGLE + '">Gemini</option></select></div>'
            + '<div class="mm-row"><label>API地址</label><input id="mm_llm_url" class="text_pole" type="text" placeholder="https://api.openai.com/v1"></div>'
            + '<div class="mm-row"><label>API密钥</label><input id="mm_llm_key" class="text_pole" type="password" autocomplete="off"></div>'
            + '<div class="mm-row"><label>模型</label><input id="mm_llm_model" class="text_pole" type="text"><select id="mm_llm_model_sel" class="text_pole" style="display:none"></select><button id="mm_llm_fetch" class="menu_button">获取</button><button id="mm_llm_test_conn" class="menu_button">测试</button></div>'
            + '</div>'

            // ─── 格式化面板 ───
            + '<div class="mm-tab-panel" data-panel="format">'
            + '<p class="mm-desc">正则提取朗读内容，或启用副LLM结构化。</p>'
            + '<div class="mm-section-title">正则规则 <button id="mm_add_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+添加</button></div>'
            + '<div class="mm-rule-header-row"><span></span><span>名称</span><span>正则</span><span style="flex:0 0 68px">模式</span><span style="flex:0 0 30px"></span></div>'
            + '<div id="mm_rule_rows"></div>'
            + '<div class="mm-section-title" style="margin-top:12px">规则预设</div>'
            + '<div class="mm-row" style="flex-wrap:wrap;gap:6px"><select id="mm_regex_presets" class="text_pole" style="min-width:120px;flex:1"></select><button id="mm_regex_save_p" class="menu_button">保存</button><button id="mm_regex_upd_p" class="menu_button">更新</button><button id="mm_regex_del_p" class="menu_button">删除</button><button id="mm_regex_export" class="menu_button">导出</button><button id="mm_regex_import" class="menu_button">导入</button></div>'
            + '<div class="mm-section-title" style="margin-top:16px">副LLM格式化</div>'
            + '<div class="mm-row"><label>启用</label><input id="mm_f_en" type="checkbox"></div>'
            + '<div class="mm-row"><label>LLM预设</label><select id="mm_f_preset_sel" class="text_pole llm-preset-sel"></select></div>'
            + '<div class="mm-row" style="flex-wrap:wrap;gap:6px"><label style="min-width:85px">模板</label><select id="mm_f_templates" class="text_pole" style="min-width:120px;flex:1"></select><button id="mm_f_save_t" class="menu_button">保存</button><button id="mm_f_upd_t" class="menu_button">更新</button><button id="mm_f_del_t" class="menu_button">删除</button><button id="mm_f_export_t" class="menu_button">导出</button><button id="mm_f_import_t" class="menu_button">导入</button></div>'
            + '<div class="mm-row" style="align-items:flex-start"><label style="padding-top:6px">系统提示词</label><textarea id="mm_f_prompt" class="text_pole" style="flex:1;width:0"></textarea></div>'
            + '<div class="mm-section-title" style="margin-top:16px">预处理规则 <button id="mm_add_pre_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+添加</button></div>'
            + '<p class="mm-desc">发给副LLM前的正则处理。</p>'
            + '<div class="mm-rule-header-row"><span></span><span>名称</span><span>正则</span><span style="flex:0 0 68px">模式</span><span style="flex:0 0 30px"></span></div>'
            + '<div id="mm_pre_rule_rows"></div>'
            + '</div>'

            + '</div></div></div>';

        document.body.insertAdjacentHTML('beforeend', panelHtml);

        // Tab切换
        document.querySelectorAll('#mm-config-mask .mm-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var t = this.dataset.tab;
                document.querySelectorAll('#mm-config-mask .mm-tab').forEach(function (b) { b.classList.remove('active'); });
                this.classList.add('active');
                document.querySelectorAll('#mm-config-mask .mm-tab-panel').forEach(function (p) { p.classList.remove('active'); });
                document.querySelector('#mm-config-mask .mm-tab-panel[data-panel="' + t + '"]').classList.add('active');if (t === 'tts') { renderVoiceLibrary(); refreshVoiceSelects(); renderBindings(); }
                if (t === 'format') { renderRules(); renderRegexPresets(); renderPreProcessRules(); }});
        });

        // 关闭
        document.getElementById('mm-config-mask').addEventListener('click', function (e) {
            if (e.target === this) this.classList.remove('mm-config-open');
        });document.querySelector('#mm-config-mask .mm-config-close').addEventListener('click', function () {
            document.getElementById('mm-config-mask').classList.remove('mm-config-open');
        });

        // TTS同步
        var syncTts = function () {
            var vs = document.getElementById('mm_voice_sel');
            s().apiKey = document.getElementById('mm_key').value;
            s().groupId = document.getElementById('mm_gid').value;
            s().apiHost = document.getElementById('mm_apihost').value;
            s().customApiHost = document.getElementById('mm_custom_host').value || '';
            s().model = document.getElementById('mm_model').value;
            s().voiceId = vs.value || document.getElementById('mm_voice').value;
            s().speed = Number(document.getElementById('mm_speed').value);
            s().vol = Number(document.getElementById('mm_vol').value);
            s().ttsLanguage = document.getElementById('mm_tts_lang').value;
            s().autoPlay = document.getElementById('mm_autoplay').checked;
            saveSettingsDebounced();
            syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());
        };

        document.getElementById('mm_apihost').addEventListener('change', function () {
            var r = document.getElementById('mm_custom_host_row');
            if (r) r.style.display = this.value === 'custom' ? '' : 'none';
        });

        document.getElementById('mm_show_bubbles').addEventListener('change', function () {
            s().showBubbles = this.checked;saveSettingsDebounced();if (this.checked) refreshAllBubbles(); else removeAllBubbles();
        });

        var syncIds = ['mm_key', 'mm_gid', 'mm_apihost', 'mm_custom_host', 'mm_model', 'mm_voice_sel', 'mm_voice', 'mm_speed', 'mm_vol', 'mm_tts_lang', 'mm_autoplay'];
        for (var si = 0; si < syncIds.length; si++) {
            var syncEl = document.getElementById(syncIds[si]);
            if (syncEl) { syncEl.addEventListener('input', syncTts); syncEl.addEventListener('change', syncTts); }
        }

        document.getElementById('mm_voice_sel').addEventListener('change', function () {
            document.getElementById('mm_voice').style.display = this.value ?'none' : '';
        });

        //测试语音
        document.getElementById('mm_test_tts').addEventListener('click', async function () {
            try {
                var testTexts = { '': '你好，我是MiniMax语音。', zh: '你好，我是MiniMax语音。', en: 'Hello, I am MiniMax voice.', ja: 'こんにちは', ko: '안녕하세요' };
                var t = testTexts[s().ttsLanguage || ''] || testTexts[''];
                var b = await getAudioBlob({ text: t, options: buildSynthesisOptions(null, null), serverPath: null });
                new Audio(URL.createObjectURL(b)).play();
                toastr.success('连通成功！');
            } catch (e) { toastr.error('测试失败: ' + e.message); }
        });

        // 语音库
        document.getElementById('mm_add_voice').addEventListener('click', function () {
            if (!s().voiceLibrary) s().voiceLibrary = [];
            s().voiceLibrary.push({ name: '', voiceId: '' });
            renderVoiceLibrary(); saveSettingsDebounced();
        });

        // 角色绑定
        document.getElementById('mm_add_b').addEventListener('click', function () {
            var c = getContext(), cid = c.characterId || c.character_id || c.name2 || 'global';
            if (!s().characterBindingsMap[cid]) s().characterBindingsMap[cid] = [];
            s().characterBindingsMap[cid].push({ targetType: TARGET_TYPE.CUSTOM, customName: '', voiceId: '', model: s().model });
            renderBindings(); saveSettingsDebounced();
        });

        // 正则规则
        document.getElementById('mm_add_rule').addEventListener('click', function () {
            if (!s().regexRules) s().regexRules = [];
            s().regexRules.push({ id: 'r' + Date.now(), enabled: true, name: '新规则', pattern: '', flags: 'g', mode: 'extract' });
            renderRules(); saveSettingsDebounced();
        });

        document.getElementById('mm_add_pre_rule').addEventListener('click', function () {
            if (!s().llmPreProcessRules) s().llmPreProcessRules = [];
            s().llmPreProcessRules.push({ id: 'p' + Date.now(), enabled: true, name: '新规则', pattern: '', mode: 'exclude' });
            renderPreProcessRules(); saveSettingsDebounced();
        });

        // 正则预设CRUD
        document.getElementById('mm_regex_save_p').addEventListener('click', function () {
            var n = prompt('预设名称：'); if (!n) return;
            if (!s().regexPresets) s().regexPresets = [];
            s().regexPresets.push({ name: n, rules: JSON.parse(JSON.stringify(s().regexRules || [])) });
            renderRegexPresets(); saveSettingsDebounced(); toastr.success('已保存');
        });

        document.getElementById('mm_regex_upd_p').addEventListener('click', function () {
            var idx = Number(document.getElementById('mm_regex_presets').value);
            if (idx < 0 || !s().regexPresets || !s().regexPresets[idx]) return;
            s().regexPresets[idx].rules = JSON.parse(JSON.stringify(s().regexRules || []));
            saveSettingsDebounced(); toastr.success('已更新');
        });

        document.getElementById('mm_regex_presets').addEventListener('change', function () {
            var idx = Number(this.value);
            if (idx < 0 || !s().regexPresets || !s().regexPresets[idx]) return;
            s().regexRules = JSON.parse(JSON.stringify(s().regexPresets[idx].rules));
            renderRules(); saveSettingsDebounced();
        });

        document.getElementById('mm_regex_del_p').addEventListener('click', function () {
            var idx = Number(document.getElementById('mm_regex_presets').value);
            if (idx < 0 || !s().regexPresets || !s().regexPresets[idx]) return;
            s().regexPresets.splice(idx, 1);
            renderRegexPresets(); saveSettingsDebounced();
        });

        document.getElementById('mm_regex_export').addEventListener('click', function () {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().regexPresets || [], null, 2)], { type: 'application/json' }));
            a.download = 'regex_presets.json'; a.click();
        });

        document.getElementById('mm_regex_import').addEventListener('click', function () {
            var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async function () {
                try {
                    var d = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(d)) {
                        if (!s().regexPresets) s().regexPresets = [];
                        s().regexPresets.push.apply(s().regexPresets, d);
                        renderRegexPresets(); saveSettingsDebounced();toastr.success('已导入' + d.length + '个');
                    }
                } catch (_) { toastr.error('导入失败'); }
            };
            inp.click();
        });

        // 格式化同步
        var syncFmt = function () {
            s().formatterEnabled = document.getElementById('mm_f_en').checked;
            s().formatterPresetIdx = Number(document.getElementById('mm_f_preset_sel').value);
            s().formatterSystemPrompt = document.getElementById('mm_f_prompt').value;
            saveSettingsDebounced();
        };

        var selFT = document.getElementById('mm_f_templates');
        var upFT = function () {
            selFT.innerHTML = '<option value="-1">--新建模板--</option>';
            var ts = s().formatterTemplates || [];
            for (var ti = 0; ti < ts.length; ti++) {
                var o = document.createElement('option'); o.value = ti; o.textContent = ts[ti].name;
                selFT.appendChild(o);
            }
        };

        var fmtIds = ['mm_f_en', 'mm_f_preset_sel', 'mm_f_prompt'];
        for (var fi = 0; fi < fmtIds.length; fi++) {
            var fEl = document.getElementById(fmtIds[fi]);
            if (fEl) { fEl.addEventListener('input', syncFmt); fEl.addEventListener('change', syncFmt); }
        }

        selFT.addEventListener('change', function () {
            var t = (s().formatterTemplates || [])[Number(this.value)];
            if (t) { document.getElementById('mm_f_prompt').value = t.content; syncFmt(); }
        });

        document.getElementById('mm_f_save_t').addEventListener('click', function () {
            var n = prompt('模板名:'); if (!n) return;
            if (!s().formatterTemplates) s().formatterTemplates = [];
            s().formatterTemplates.push({ name: n, content: document.getElementById('mm_f_prompt').value });
            upFT(); saveSettingsDebounced();
        });

        document.getElementById('mm_f_upd_t').addEventListener('click', function () {
            var idx = Number(selFT.value);
            if (idx >= 0 && s().formatterTemplates && s().formatterTemplates[idx]) {
                s().formatterTemplates[idx].content = document.getElementById('mm_f_prompt').value;
                saveSettingsDebounced(); toastr.success('已更新');
            }
        });

        document.getElementById('mm_f_del_t').addEventListener('click', function () {
            var idx = Number(selFT.value);
            if (idx >= 0 && s().formatterTemplates) { s().formatterTemplates.splice(idx, 1); upFT(); saveSettingsDebounced(); }
        });

        document.getElementById('mm_f_export_t').addEventListener('click', function () {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().formatterTemplates || [], null, 2)], { type: 'application/json' }));
            a.download = 'fmt_templates.json'; a.click();
        });

        document.getElementById('mm_f_import_t').addEventListener('click', function () {
            var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async function () {
                try {
                    var d = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(d)) {
                        if (!s().formatterTemplates) s().formatterTemplates = [];
                        s().formatterTemplates.push.apply(s().formatterTemplates, d);
                        upFT(); saveSettingsDebounced();
                        toastr.success('已导入' + d.length + '个');
                    }
                } catch (_) { toastr.error('导入失败'); }
            };
            inp.click();
        });

        // LLM预设CRUD
        document.getElementById('mm_llm_presets').addEventListener('change', function () {
            loadLlmPresetFieldsGlobal(Number(this.value));
        });

        document.getElementById('mm_llm_save_p').addEventListener('click', function () {
            var n = prompt('预设名:'); if (!n) return;
            var ms = document.getElementById('mm_llm_model_sel');
            var m = ms.style.display !== 'none' ? ms.value : document.getElementById('mm_llm_model').value;
            s().llmPresets.push({
                name: n,
                url: document.getElementById('mm_llm_url').value,
                key: document.getElementById('mm_llm_key').value,
                format: document.getElementById('mm_llm_format').value,
                model: m,});
            refreshAllLlmPresetSelects();
            document.getElementById('mm_llm_presets').value = s().llmPresets.length - 1;
            saveSettingsDebounced(); toastr.success('已保存');
        });

        document.getElementById('mm_llm_upd_p').addEventListener('click', function () {
            var idx = Number(document.getElementById('mm_llm_presets').value);
            if (idx < 0 || idx >= s().llmPresets.length) return;
            var ms = document.getElementById('mm_llm_model_sel');
            var m = ms.style.display !== 'none' ? ms.value : document.getElementById('mm_llm_model').value;
            s().llmPresets[idx] = {
                name: s().llmPresets[idx].name,
                url: document.getElementById('mm_llm_url').value,
                key: document.getElementById('mm_llm_key').value,
                format: document.getElementById('mm_llm_format').value,
                model: m,
            };
            refreshAllLlmPresetSelects();
            document.getElementById('mm_llm_presets').value = idx;
            saveSettingsDebounced(); toastr.success('已更新');
        });

        document.getElementById('mm_llm_del_p').addEventListener('click', function () {
            var idx = Number(document.getElementById('mm_llm_presets').value);
            if (idx < 0 || idx >= s().llmPresets.length) return;
            s().llmPresets.splice(idx, 1);
            if (s().formatterPresetIdx >= s().llmPresets.length) s().formatterPresetIdx = s().llmPresets.length - 1;
            refreshAllLlmPresetSelects();
            var ni = Number(document.getElementById('mm_llm_presets').value);
            if (ni >=0) loadLlmPresetFieldsGlobal(ni);
            else {
                document.getElementById('mm_llm_url').value = '';
                document.getElementById('mm_llm_key').value = '';
                document.getElementById('mm_llm_model').value = '';
                document.getElementById('mm_llm_format').value = API_FORMATS.OAI;
                document.getElementById('mm_llm_model').style.display = '';
                document.getElementById('mm_llm_model_sel').style.display = 'none';
            }
            saveSettingsDebounced();
        });

        document.getElementById('mm_llm_fetch').addEventListener('click', async function () {
            var u = document.getElementById('mm_llm_url').value.trim().replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
            var k = document.getElementById('mm_llm_key').value.trim();
            var f = document.getElementById('mm_llm_format').value;
            try {
                var models = [];
                if (f === API_FORMATS.OAI) {
                    var d = await proxyFetch(u + '/models', { headers: k ? { 'Authorization': 'Bearer ' + k } : {} });
                    models = (d.data || []).map(function (x) { return typeof x === 'string' ? x : x.id; });
                } else {
                    var d2 = await proxyFetch(u + '/v1beta/models', { headers: k ? { 'x-goog-api-key': k } : {} });
                    models = (d2.models || []).map(function (x) { return x.name.replace('models/', ''); });
                }
                if (models.length) {
                    var sel = document.getElementById('mm_llm_model_sel');
                    sel.innerHTML = '';
                    sel.style.display = '';
                    document.getElementById('mm_llm_model').style.display = 'none';
                    for (var mi = 0; mi < models.length; mi++) {
                        var o = document.createElement('option'); o.value = models[mi]; o.textContent = models[mi];
                        sel.appendChild(o);
                    }
                    sel.value = models[0];
                    toastr.success('获取成功');
                }
            } catch (e) { toastr.error(e.message); }
        });

        document.getElementById('mm_llm_test_conn').addEventListener('click', async function () {
            var u = document.getElementById('mm_llm_url').value.trim();
            var k = document.getElementById('mm_llm_key').value.trim();
            var f = document.getElementById('mm_llm_format').value;
            var ms = document.getElementById('mm_llm_model_sel');
            var m = ms.style.display !== 'none' ? ms.value : document.getElementById('mm_llm_model').value;
            try {
                if (f === API_FORMATS.OAI) {
                    await proxyFetch(normalizeOaiUrl(u), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
                        body: { model: m, messages: [{ role: 'user', content: 'Hi' }], temperature: 0.1 },
                    });
                } else {
                    await proxyFetch(u.replace(/\/+$/, '') + '/v1beta/models/' + m + ':generateContent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
                        body: { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] },
                    });
                }
                toastr.success('连通成功！');
            } catch (e) { toastr.error(e.message); }
        });

        upFT();}

    populateConfigFields();
    document.getElementById('mm-config-mask').classList.add('mm-config-open');
}

//═══════════════════════════════
//  启动入口
// ═══════════════════════════════

function createUi() {
    injectStyles();
    $('#extensionsMenu').append(
        '<div id="mm_wand_item" class="list-group-item flex-container flexGap5" title="MiniMax TTS">'
        + '<div class="fa-solid fa-volume-high extensionsMenuExtensionButton"></div>MiniMax语音</div>'
    );
    $('#mm_wand_item').on('click', function () {
        var m = document.getElementById('extensionsMenu');
        if (m) m.style.display = 'none';
        openConfigPanel();
    });
    loadSettings();
    syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());
    refreshAllLlmPresetSelects();eventSource.on(event_types.CHARACTER_SELECTED, function () { if (document.getElementById('mm_b_rows')) renderBindings(); });
    eventSource.on(event_types.CHAT_CHANGED, function () { if (document.getElementById('mm_b_rows')) renderBindings(); });
}

jQuery(async function () {
    loadSettings();
    createUi();

    var timer, longP;

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async function (id) {
        if (s().enabled && s().autoPlay) {
            if (await generateMessageSpeech(id, false)) playGeneratedMessage(id);
        } else {
            extractSegmentsOnly(id);
        }
        injectBubbles(id);
    });

    eventSource.on(event_types.CHAT_CHANGED, function () {
        setTimeout(refreshAllBubbles, 600);
    });

    // 长按生成
    $(document).on('mousedown touchstart', '.mes_quote_tts', function () {
        var id = Number($(this).closest('.mes').attr('mesid'));
        longP = false;
        timer = setTimeout(async function () {
            longP = true;
            if (s().formatterEnabled) {
                toastr.info('生成中...');
                if (await generateMessageSpeech(id, true)) toastr.success('完成！');
            } else {
                if (await generateMessageSpeech(id, true)) playGeneratedMessage(id);
            }
        }, 600);
    }).on('mouseup mouseleave touchend touchcancel', '.mes_quote_tts', function () {
        clearTimeout(timer);
    });

    // 单击播放
    $(document).on('click', '.mes_quote_tts', function (e) {
        if (longP) return;
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        var target = e.target;
        clickTimer = setTimeout(async function () {
            clickTimer = null;
            var id = Number($(target).closest('.mes').attr('mesid'));
            var data = getMessageData(id);
            if (s().formatterEnabled) {
                if (!s().serverHistory[data.key] || !s().serverHistory[data.key].versions || !s().serverHistory[data.key].versions.length) {
                    toastr.warning('请先长按');
                    return;
                }
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

    // 定时刷新
    setInterval(function () {
        refreshAllMessageButtons();
        refreshAllBubbles();
    }, 1000);

    // 气泡点击播放
    $(document).on('click', '.mm-bubble', async function () {
        var $b = $(this);
        if ($b.hasClass('mm-bubble-loading') || $b.hasClass('mm-bubble-playing')) return;
        var mesid = Number($b.data('mesid'));
        var segidx = Number($b.data('segidx'));
        var data = getMessageData(mesid);
        var h = s().serverHistory[data.key];
        if (!h || !h.versions || !h.versions[h.activeIndex]) return;
        var item = h.versions[h.activeIndex].items[segidx];
        if (!item) return;

        $b.addClass('mm-bubble-loading');
        try {
            var blob = await getAudioBlob(item);
            $b.removeClass('mm-bubble-loading').addClass('mm-bubble-playing');
            refreshBubbleStates(mesid);
            refreshAllMessageButtons();
            var u = URL.createObjectURL(blob);
            var a = new Audio(u);
            a.onended = function () { URL.revokeObjectURL(u); $b.removeClass('mm-bubble-playing'); };
            a.onerror = function () { URL.revokeObjectURL(u); $b.removeClass('mm-bubble-playing'); };
            await a.play();
        } catch (e) {
            $b.removeClass('mm-bubble-loading mm-bubble-playing');
            toastr.error('播放失败: ' + e.message);
        }
    });
});
