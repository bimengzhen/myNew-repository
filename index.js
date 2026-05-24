import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';


const MODULE_NAME = 'minimax_quote_tts';
const PROXY_ENDPOINT = '/api/minimax/generate-voice';
const DEFAULT_API_HOST = 'https://api.minimax.chat';
const API_HOST_OPTIONS = [{ value: 'https://api.minimax.chat', label: '国内源(api.minimax.chat)' },
    { value: 'https://api.minimax.io', label: '国际源(api.minimax.io)' },
    { value: 'https://api.minimaxi.chat', label: '备用源(api.minimaxi.chat)' },
    { value: 'custom', label: '🔗自定义中转站' },
];
const TARGET_TYPE = { CURRENT_CHARACTER: 'current_character', CURRENT_USER: 'current_user', CUSTOM: 'custom' };
const API_FORMATS = { OAI: 'openai', GOOGLE: 'google' };
const MODEL_OPTIONS = [
    { value: 'speech-2.8-turbo', label: 'speech-2.8-turbo(最新极速)' },
    { value: 'speech-2.8-hd', label: 'speech-2.8-hd(最新高清)' },
    { value: 'speech-2.6-turbo', label: 'speech-2.6-turbo' },
    { value: 'speech-2.6-hd', label: 'speech-2.6-hd' },
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
    model: 'speech-2.8-hd', voiceId: 'English_expressive_narrator',
    speed: 1, vol: 1, pitch: 0, emotion: '', audioFormat: 'mp3', ttsLanguage: '',
    maxQuotesPerMessage: 4, minLength: 1, maxLength: 300, ignoreCodeBlocks: true,
    characterBindingsMap: {}, llmPresets: [], formatterTemplates: [],
    formatterEnabled: false, formatterPresetIdx: -1,
    formatterSystemPrompt: '请以严格的JSON格式返回：{"segments":[{"text":"...","speaker":"...","emotion":"...","speed":1.0,"vol":1.0,"pitch":0}]}.仅保留可朗读的内容。',
    serverHistory: {}, voiceLibrary: [], regexRules: [], regexPresets: [],
    llmPreProcessRules: [], showBubbles: false,
    defaultMaleVoiceId: '', defaultFemaleVoiceId: '',
    defaultMaleModel: '', defaultFemaleModel: '',
    autoClearInterval: 4, _messageCounter: 0,
    showFloatingBtn: true, floatingBtnImg: '',
    floatingBtnX: null, floatingBtnY: null,
};

let playbackQueue = [], isPlaying = false;
let activeAudio = new Audio();
const localAudioCache = new Map();
let mmInlineEditState = null;


function s() { return extension_settings[MODULE_NAME]; }
window._mmtts = function() { return extension_settings[MODULE_NAME]; };

function escHtml(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

var ttsLogs = [];
function ttsLog(msg, type) {
    var t = new Date().toLocaleTimeString();
    var line = '[' + t + '] ' + msg;
    console.log('[MiniMax TTS] ' + msg);
    ttsLogs.push({ t: t, msg: msg, type: type || 'info' });
    if (ttsLogs.length > 200) ttsLogs.shift();
    var el = document.getElementById('mm_log_box');
    if (el) {
        var color = type === 'error' ? '#ef5350' : type === 'success' ? '#4caf50' : type === 'warn' ? '#ff9800' : '#aaa';
        el.innerHTML += '<div style="color:' + color + ';margin:2px 0;font-size:0.78rem;word-break:break-all">' + escHtml(line) + '</div>';
        el.scrollTop = el.scrollHeight;
    }
}
function renderTtsLogs() {
    var el = document.getElementById('mm_log_box');

    if (!el) {
        return;
    }

    el.innerHTML = '';

    for (var i = 0; i < ttsLogs.length; i++) {
        var item = ttsLogs[i];
        var type = item.type || 'info';
        var color = type === 'error' ? '#ef5350' : type === 'success' ? '#4caf50' : type === 'warn' ? '#ff9800' : '#aaa';
        var line = '[' + item.t + '] ' + item.msg;

        el.innerHTML += '<div style="color:' + color + ';margin:2px 0;font-size:0.78rem;word-break:break-all">' + escHtml(line) + '</div>';
    }

    el.scrollTop = el.scrollHeight;
}

function parsePattern(str) { const p = (str || '').trim(); if (p.startsWith('/')) { const last = p.lastIndexOf('/'); if (last > 0) return p.slice(1, last); } return p; }
function isHtmlMessage(mes) { return /class="|<div[\s>]|<table|<details|<summary|style="/i.test(mes || ''); }
function simpleHash(t) { if (!t) return 0; let h = 0; for (let i = 0; i < t.length; i++) h = ((h << 5) - h) + t.charCodeAt(i), h |= 0; return Math.abs(h); }
function normalizeRegexFlags(v, ensureGlobal) {
    var raw = String(v || '').toLowerCase();
    var allowed = 'dgimsuvy';
    var out = '';

    for (var i = 0; i < raw.length; i++) {
        var ch = raw[i];
        if (allowed.indexOf(ch) === -1) continue;
        if (out.indexOf(ch) >= 0) continue;
        out += ch;
    }

    if (ensureGlobal && out.indexOf('g') === -1) {
        out += 'g';
    }

    return out || (ensureGlobal ? 'g' : '');
}
function buildMessageKey(ctx, id, m) { return `${ctx.chatId ||'x'}:${id}:${m?.swipe_id || 0}:${simpleHash(m?.mes)}`; }
function getMessageData(id) { const ctx = getContext(), m = ctx?.chat?.[id]; return { ctx, message: m, key: m ? buildMessageKey(ctx, id, m) : '' }; }
function normalizeOaiUrl(url) { let u = (url || '').trim().replace(/\/+$/, ''); if (!u) return ''; if (!u.endsWith('/chat/completions')) u += '/chat/completions'; return u; }

function getBuiltinQuoteRule() {
    return {
        id: 'builtin-quotes', enabled: true, name: '引号内容',
        pattern: '[\u0022\u201c\u300c\u300e\u2018]([^\u0022\u201c\u201d\u300c\u300d\u300e\u300f\u2018\u2019]{1,500}?)[\u0022\u201d\u300d\u300f\u2019]',
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
        headers: {'Content-Type': 'application/json', ...(opt.headers || {}) },
        body: opt.body != null ? JSON.stringify(opt.body) : undefined,
    });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch (_) { d = t; }
    if (!r.ok) throw new Error(d?.error?.message || d?.error || (typeof d === 'string' ? d : `HTTP ${r.status}`));
    return d;
}

function getAudioFieldFromResponse(d) {
    return d.data?.audio_url || d.audio_url || d.data?.url || d.url|| d.data?.audio_file || d.audio_file || d.data?.file_url || d.file_url|| d.data?.audio || d.audio || d.audio_data || d.data?.audio_data;
}

async function extractAudioFromResponse(d, fmt) {
    var urlFields = [
        d.data?.audio_url, d.audio_url,
        d.data?.url, d.url,
        d.data?.audio_file, d.audio_file,
        d.data?.file_url, d.file_url,
        d.data?.audio, d.audio,
    ];
    for (var i = 0; i < urlFields.length; i++) {
        var u = urlFields[i];
        if (u && typeof u === 'string' && (u.startsWith('http') || u.startsWith('//'))) {
            var fullUrl = u.startsWith('//') ? 'https:' + u : u;
            console.log('[MiniMax TTS] 音频URL:', fullUrl.slice(0, 80));
            // 不fetch，直接返回URL标记，让Audio标签直接播放
            return { _audioUrl: fullUrl };
        }
    }
    var a = d.data?.audio || d.audio || d.audio_data || d.data?.audio_data;
    if (a && typeof a === 'string' && !a.startsWith('http')) {
        var bc = atob(a), ba = new Uint8Array(bc.length);
        for (var j = 0; j < bc.length; j++) ba[j] = bc.charCodeAt(j);
        var mm = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', flac: 'audio/flac' };
        return new Blob([ba], { type: mm[fmt] || 'audio/mpeg' });
    }
    var h = d.data?.audio_hex || d.audio_hex;
    if (h && typeof h === 'string') {
        return new Blob([new Uint8Array(h.match(/.{1,2}/g).map(function (b) { return parseInt(b, 16); }))], { type: 'audio/mpeg' });
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
        for (constpu of (i === 0 ? urls : [urls[0]])) {
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

    let url;
    const apiHost = (set.apiHost || DEFAULT_API_HOST).replace(/\/+$/, '');

    if (apiHost === 'custom') {
        const ch = (set.customApiHost || '').trim().replace(/\/+$/, '');
        if (!ch) throw new Error('请填写中转地址');
        url = ch;
    } else {
        url = apiHost + '/v1/t2a_v2?GroupId=' + encodeURIComponent((set.groupId || '').trim());
    }

    const voiceId = options.voiceId || set.voiceId;
    const speed = Number(options.speed ?? set.speed);
    const vol = Number(options.vol ?? set.vol);
    const pitch = Number(options.pitch ?? set.pitch);
    const emotion = options.emotion || set.emotion || '';
    const lang = options.language || set.ttsLanguage || '';
    const fmt = options.audioFormat || set.audioFormat || 'mp3';
    const model = options.model || set.model;

    var body = {
        model: model,
        text: text,
        stream: false,
        language_boost: lang ||'auto',
        output_format: 'url',
        voice_setting: {
            voice_id: voiceId,
            speed: speed,
            vol: vol,
            pitch: pitch,emotion: emotion ||'neutral',
        },
        pronunciation_dict: {
            tone: [],},
        audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: fmt,
            channel: 1,
        },
        voice_modify: {
            pitch: 0,
            intensity: 0,
            timbre: 0,
            sound_effects: '',
        },
    };

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
        if (r.ok) {
            const b = await r.blob();
            localAudioCache.set(ck, b);
            return b;
        }
    }

    let blob;
    try {
        const r = await fetch(PROXY_ENDPOINT, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: item.text,
                apiHost: s().apiHost,
                model: item.options.model,
                voiceId: item.options.voiceId,
                speed: item.options.speed,
                volume: item.options.vol,
                pitch: item.options.pitch,
                format: item.options.audioFormat,
                emotion: item.options.emotion,
                language: item.options.language || undefined,
            }),
        });

        if (r.status === 404|| r.status === 501|| r.status === 405) {
            throw new Error('NO_PROXY');
        }

        if (!r.ok) {
            let m = 'HTTP' + r.status;
            try {
                const e = await r.json();
                m = e.error || e.message || m;
            } catch (_) {}
            throw new Error(m);
        }

        blob = await r.blob();
    } catch (pe) {
        console.warn('[MiniMax] 代理失败,直连:', pe.message);
        blob = await directMinimaxTts(item.text, item.options);
    }

    if (blob && blob._audioUrl) {
        return blob;
    }

    localAudioCache.set(ck, blob);

    if (blob instanceof Blob) {
        uploadToSTServer(blob, ck + '.' + item.options.audioFormat).then(function (p) {
            if (!p) return;

            item.serverPath = p;

            try {
                var sh = s().serverHistory || {};
                for (var key in sh) {
                    var h = sh[key];
                    if (!h || !h.versions) continue;

                    for (var vi = 0; vi < h.versions.length; vi++) {
                        var ver = h.versions[vi];
                        if (!ver || !ver.items) continue;

                        for (var ii = 0; ii < ver.items.length; ii++) {
                            var it = ver.items[ii];
                            if (!it) continue;

                            var same = simpleHash(it.text) === simpleHash(item.text)
                                && simpleHash(JSON.stringify(it.options)) === simpleHash(JSON.stringify(item.options));

                            if (same && !it.serverPath) {
                                it.serverPath = p;}
                        }
                    }
                }
            } catch (_) {}

            saveSettingsDebounced();
        });
    }

    return blob;
}


async function playNext() {
    if (!playbackQueue.length) { isPlaying = false; return; }
    isPlaying = true;
    var item = playbackQueue.shift();
    if (item.pauseMs) { await new Promise(function (r) { setTimeout(r, item.pauseMs); }); playNext(); return; }
    try {
        var result = await getAudioBlob(item);
        if (result && result._audioUrl) {
            // 直接用URL播放，绕过CORS
            activeAudio.src = result._audioUrl;
            activeAudio.onended = function () { playNext(); };
            activeAudio.onerror = function () { playNext(); };
            await activeAudio.play();
        } else {
            var u = URL.createObjectURL(result);
            activeAudio.src = u;
            activeAudio.onended = function () { URL.revokeObjectURL(u); playNext(); };
            activeAudio.onerror = function () { URL.revokeObjectURL(u); playNext(); };
            await activeAudio.play();
        }
    } catch (e) { console.error('[MiniMax TTS]', e); playNext(); }
}


function applyPreProcessRules(text) {
    var allRules = s().llmPreProcessRules || [];
    var rules = allRules.filter(function (r) { return r.enabled && r.pattern; });
    ttsLog('预处理: 总规则=' + allRules.length + ' 启用=' + rules.length);
    if (!rules.length) {
        ttsLog('无启用规则，跳过预处理', 'warn');
        return text;
    }
    for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        var patternStr = parsePattern(rule.pattern);
        ttsLog('  规则#' + (ri + 1) + ' [' + (rule.name || '?') + '] 模式=' + rule.mode + ' 正则=' + patternStr);
        var re;
        try {
            var fl = normalizeRegexFlags(rule.flags, true);
            re = new RegExp(patternStr, fl);
        } catch (e) {
            ttsLog('  ❌ 正则编译失败: ' + e.message, 'error');
            continue;
        }
        if (rule.mode === 'extract') {
            var matches = [], x;
            while ((x = re.exec(text)) !== null) {
                var t = (x[1] !== undefined ? x[1] : x[0]).trim();
                if (t) matches.push(t);
            }
            ttsLog('  提取匹配数: ' + matches.length + (matches.length ? ' ✓' : ' ✗'), matches.length ? 'success' : 'warn');
            if (matches.length) {
                text = matches.join('\n');
                ttsLog('  提取后长度: ' + text.length + '字');
            }
        } else {
            var before = text.length;
            text = text.replace(re, '');
            ttsLog('  排除: ' + before + '字 → ' + text.length + '字(删' + (before - text.length) + '字)');
        }
    }
    ttsLog('预处理完成, 最终长度: ' + text.length + '字');
    return text.trim();
}


async function formatWithSecondaryApi(m, cachedItemsForLabeling) {
    ttsLog('=== 副LLM分析开始 ===');
    var set = s(), preset = (set.llmPresets || [])[set.formatterPresetIdx];
    if (!preset) {
        ttsLog('错误: 未选择LLM预设 idx=' + set.formatterPresetIdx + ' 总数=' + (set.llmPresets || []).length, 'error');
        throw new Error('请先选择LLM预设');
    }
    ttsLog('预设: ' + preset.name + ' 模型: ' + preset.model + ' 格式: ' + (preset.format || API_FORMATS.OAI));
    ttsLog('消息长度: ' + (m.mes || '').length + '字');

    var fmt = preset.format || API_FORMATS.OAI, prompt = set.formatterSystemPrompt;
    var inputText = applyPreProcessRules(m.mes);

    var preExtracted = [];

    // 优先使用已经生成的气泡/正则缓存，不再从预处理后的正文重新提取
    if (cachedItemsForLabeling && cachedItemsForLabeling.length) {
        preExtracted = cachedItemsForLabeling.map(function (it, idx) {
            return {
                idx: idx,
                text: it.text || '',
                fullMatch: it.fullMatch || it.text || '',
                type: it.type || 'cached',
                pos: idx,
            };
        }).filter(function (x) {
            return x.text && x.text.trim();
        });

        ttsLog('使用已有气泡缓存进行API标注: ' + preExtracted.length + ' 个片段', 'success');
    } else {
        // 没有缓存时，才从原文/预处理文本里提取
        preExtracted = extractForLlmLabeling(m.mes || '');

        if (!preExtracted.length) {
            preExtracted = extractForLlmLabeling(inputText);
        }

        ttsLog('无已有气泡缓存，尝试正则预提取: ' + preExtracted.length + ' 个片段', preExtracted.length ? 'success' : 'warn');
    }

    if (!preExtracted.length) {
        ttsLog('正则预提取为空，且没有可用气泡缓存', 'warn');
        return [];
    }

    ttsLog('待API标注 ' + preExtracted.length + ' 个片段', 'success');
    ttsLog('预处理后: ' + inputText.slice(0, 100) + (inputText.length > 100 ? '...' : ''));

    var text = '';
    try {
        if (fmt === API_FORMATS.OAI) {
            var reqUrl = normalizeOaiUrl(preset.url);
            ttsLog('请求URL: ' + reqUrl);
            var d = await proxyFetch(reqUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (preset.key || '').trim() },
                body: {
                    model: preset.model,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content:'原文上下文：\n' + inputText + '\n\n'
                           + '下面是程序已经按顺序提取出的片段。请只根据idx给每个片段标注speaker/gender/emotion/speed/vol/pitch，不要返回text，不要修改idx：\n'
                           + JSON.stringify(preExtracted.map(function(x) {
                               return { idx: x.idx, text: x.text, type: x.type };
                           }), null, 2)}],
                    temperature: 0.1,
                    max_tokens: 8192
},
            });

            ttsLog('API完整响应: ' + JSON.stringify(d).slice(0, 500));            
            text = d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
        } else {
            var bu = (preset.url || '').trim().replace(/\/+$/, '');
            var reqUrl2 = bu + '/v1beta/models/' + preset.model + ':generateContent';
            ttsLog('请求URL: ' + reqUrl2);
            var d2 = await proxyFetch(reqUrl2, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': (preset.key || '').trim() },
                body: { contents: [{ role: 'user', parts: [{ text:'System Prompt: ' + prompt + '\n\n'
                  + '原文上下文：\n' + inputText + '\n\n'
                  + '下面是程序已经按顺序提取出的片段。请只根据idx给每个片段标注speaker/gender/emotion/speed/vol/pitch，不要返回text，不要修改idx：\n'
                  + JSON.stringify(preExtracted.map(function(x) {
                      return { idx: x.idx, text: x.text, type: x.type };
                }), null, 2)
            }] }] },
            });

            ttsLog('API完整响应: ' + JSON.stringify(d2).slice(0, 500));
            text = d2.candidates && d2.candidates[0] ? d2.candidates[0].content.parts[0].text : '';
        }
    } catch (e) {
        ttsLog('LLM请求失败: ' + e.message, 'error');
        throw e;
    }

    ttsLog('LLM原始返回: ' + text.slice(0, 500), text ? 'info' : 'warn');

    if (!text) {
        ttsLog('LLM返回空内容', 'error');
        throw new Error('LLM返回空内容');
    }

    // 清理markdown代码块
    var cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    ttsLog('清理后: ' + cleaned.slice(0, 300));

    var match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
        ttsLog('无法提取JSON: ' + cleaned.slice(0, 200), 'error');
        throw new Error('AI返回无有效JSON');
    }

    try {
        var parsed = JSON.parse(match[0]);
        var labels = parsed.segments || [];
        ttsLog('LLM标注返回 ' + labels.length + ' 个标签', 'success');

        // 按idx建索引
        var labelMap = {};
        for (var li = 0; li < labels.length; li++) {
            if (labels[li].idx !== undefined) {
                labelMap[Number(labels[li].idx)] = labels[li];
            }
        }

        // 合并：text/fullMatch来自正则，其余来自LLM
        var segments = [];
        for (var ei = 0; ei < preExtracted.length; ei++) {
            var base = preExtracted[ei];
            var lab = labelMap[base.idx] || {};
            segments.push({
                text: base.text,
                fullMatch: base.fullMatch,
                speaker: lab.speaker || lab.name || '未知',
                gender: lab.gender || '',
                emotion: lab.emotion || 'neutral',
                speed: lab.speed != null ? lab.speed : 1.0,
                vol: lab.vol != null ? lab.vol : 1.0,
                pitch: lab.pitch != null ? lab.pitch : 0,
                apiLabeled: true,
            });
        }

        ttsLog('合并完成: ' + segments.length + '个片段', 'success');

        // 检查LLM标注覆盖率
        var unlabeled = 0;
        for (var si = 0; si < segments.length; si++) {
            var seg = segments[si];
            var hasLabel = labelMap[si] ? '✓' : '✗未标注';
            ttsLog('#' + (si + 1) + ' [' + hasLabel + '] [' + seg.speaker + '] ' + seg.text.slice(0, 30) + ' emotion=' + seg.emotion, hasLabel === '✓' ? 'success' : 'warn');
            if (!labelMap[si]) unlabeled++;
        }

        if (unlabeled > 0) {
            ttsLog('⚠️ ' + unlabeled + '个片段未被LLM标注，使用默认值', 'warn');
        }

        return segments;
    } catch (e) {
        ttsLog('JSON解析失败: ' + e.message + ' 原文: ' + match[0].slice(0, 200), 'error');
        throw new Error('JSON解析失败: ' + e.message);
    }
}    



function findCharacterBinding(name) {
    if (!name) return null;

    var set = s();
    var ctx = getContext();
    var n = name.toLowerCase().trim();
    var cid = ctx.characterId || ctx.character_id || ctx.name2|| 'global';

    var currentBindings = set.characterBindingsMap[cid] || [];
    var globalBindings = set.characterBindingsMap.global || [];

    function matchBindingList(list) {
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            var bn = '';

            if (b.targetType === TARGET_TYPE.CUSTOM) {
                bn = b.customName || '';
            } else if (b.targetType === TARGET_TYPE.CURRENT_CHARACTER) {
                bn = ctx.name2 || '';
            } else if (b.targetType === TARGET_TYPE.CURRENT_USER) {
                bn = ctx.name1 || '';
            }

            if (bn && bn.toLowerCase().trim() === n) {
                return b;
            }

            if (b.aliases) {
                var aliasList = b.aliases.split(',');
                for (var j = 0; j < aliasList.length; j++) {
                    var alias = aliasList[j].trim().toLowerCase();
                    if (!alias) continue;

                    if (alias === n || n.indexOf(alias) >= 0 || alias.indexOf(n) >= 0) {
                        return b;
                    }
                }
            }
        }

        return null;
    }

    var hit = matchBindingList(currentBindings);
    if (hit) return hit;

    hit = matchBindingList(globalBindings);
    if (hit) return hit;

    return null;
}



function buildSynthesisOptions(seg, m) {
    var set = s();
    var speakerName = seg ? seg.speaker : (m ? m.name : '');
    var b = findCharacterBinding(speakerName);

    var voiceId = set.voiceId, model = set.model;

    if (b) {
        voiceId = b.voiceId || voiceId;
        model = b.model || model;
    } else {
        var gender = (seg && seg.gender) ? seg.gender.toLowerCase() : '';
        if (gender === 'male' && set.defaultMaleVoiceId) {
            voiceId = set.defaultMaleVoiceId;
            model = set.defaultMaleModel || model;
        } else if (gender === 'female' && set.defaultFemaleVoiceId) {
            voiceId = set.defaultFemaleVoiceId;
            model = set.defaultFemaleModel || model;
        }
    }

    if (seg && seg.voiceId) voiceId = seg.voiceId;
    if (seg && seg.model) model = seg.model;

    return {
        model: model, voiceId: voiceId,
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

        if (rule.mode !== 'extract') {
            continue;
        }

        fl = normalizeRegexFlags(rule.flags, true);

        try {
            re = new RegExp(parsePattern(rule.pattern), fl);
        } catch (_) {
            continue;
        }

        while ((qm = re.exec(cleanText)) !== null) {
            var inner = '';

            for (var capi = 1; capi < qm.length; capi++) {
                if (qm[capi]) {
                    inner = qm[capi];
                    break;
                }
            }

            inner = String(inner || '').replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
            var full = (qm[0] || '').replace(/\n+/g, ' ').trim();
            var pos = qm.index || 0;
            var end = pos + (qm[0] || '').length;

            if (!inner || inner.length < 2) {
                continue;
            }

            if (!full) {
                re.lastIndex++;
                continue;
            }

            extracted.push({
                text: inner,
                fullMatch: full,
                speaker: speaker,
                pos: pos,
                end: end,
            });
        }
    }

    // 按原文位置排序
    extracted.sort(function (a, b) {
        if ((a.pos || 0) !== (b.pos || 0)) {
            return (a.pos || 0) - (b.pos || 0);
        }

        return (b.end || 0) - (a.end || 0);
    });

    // 去掉重复和重叠片段
    var deduped = [];

    for (i = 0; i < extracted.length; i++) {
        var cur = extracted[i];
        var duplicated = false;

        for (var j = 0; j < deduped.length; j++) {
            var old = deduped[j];

            var sameText = cur.text === old.text;
            var sameFull = cur.fullMatch === old.fullMatch;
            var samePos = cur.pos === old.pos && cur.end === old.end;

            var overlap = cur.pos < old.end && cur.end > old.pos;

            if (samePos || sameFull || sameText && overlap || overlap) {
                duplicated = true;

                // 如果当前这个更长，就替换旧的
                if ((cur.end - cur.pos) > (old.end - old.pos)) {
                    deduped[j] = cur;
                }

                break;
            }
        }

        if (!duplicated) {
            deduped.push(cur);
        }
    }

    extracted = deduped;

    for (i = 0; i < rules.length; i++) {
        rule = rules[i];

        if (rule.mode !== 'exclude') {
            continue;
        }

        fl = normalizeRegexFlags(rule.flags, true);

        try {
            re = new RegExp(parsePattern(rule.pattern), fl);
        } catch (_) {
            continue;
        }

        extracted = extracted.filter(function (seg) {
            re.lastIndex = 0;
            return !re.test(seg.text);
        });
    }

    return extracted;
}



function extractForLlmLabeling(text) {
    var extracted = [];

    function addMatches(pattern, type) {
        var re = new RegExp(pattern, 'gs');
        var m;
        while ((m = re.exec(text)) !== null) {
            var full = (m[0] || '').trim();
            var inner = (m[1] || '').trim();
            if (!inner || inner.length < 1) continue;
            extracted.push({
                idx: extracted.length,
                text: inner,
                fullMatch: full,
                type: type,
                pos: m.index,
            });
        }
    }

    // 引号
    addMatches('["\u201c\u300c\u300e\u2018]([\s\S]{1,500}?)["\u201d\u300d\u300f\u2019]', 'quote');

    // 星号
    addMatches('\\*([\s\S]{1,500}?)\\*', 'action');

    // 按原文顺序排序
    extracted.sort(function (a, b) { return a.pos - b.pos; });

    // 重新编号
    for (var i = 0; i < extracted.length; i++) extracted[i].idx = i;

    return extracted;
}

async function generateMessageSpeech(id, forced) {
    var data = getMessageData(id);
    var message = data.message, key = data.key;
    if (!message || (s().onlyCharacter && message.is_user)) return false;
    if (!message || message.is_system || (s().onlyCharacter && message.is_user)) return false;

    // 酒馆斜体/Markdown 可能会渲染成 HTML，这里不能直接跳过
    // if (isHtmlMessage(message.mes)) return false;

    console.log('[MiniMax TTS] === 生成语音 === id=' + id + ' forced=' + forced + ' formatterEnabled=' + s().formatterEnabled + ' enabled=' + s().enabled);

    var h = s().serverHistory[key];

    // 格式化器开启时，自动清除旧的正则数据
    if (s().formatterEnabled && !forced && h && h.versions && h.versions.length) {
        var v = h.versions[h.activeIndex];
        if (v && !v._fromFormatter) {
            console.log('[MiniMax TTS] 检测到旧正则数据，清除重新分析');
            delete s().serverHistory[key];
            h = null;
        }
    }

    if (!forced && h && h.versions && h.versions.length) {
        console.log('[MiniMax TTS] 已有缓存，跳过');
        return true;
    }

    try {
        var raw;
        if (s().formatterEnabled) {
            console.log('[MiniMax TTS] 调用副LLM分析...');
            console.log('[MiniMax TTS] presetIdx=' + s().formatterPresetIdx + ' presets数量=' + (s().llmPresets || []).length);

            var cachedItemsForLabeling = null;

            if (h && h.versions && h.versions.length) {
                var activeVer = h.versions[h.activeIndex];

                if (activeVer && activeVer.items && activeVer.items.length) {
                    cachedItemsForLabeling = activeVer.items;
                    console.log('[MiniMax TTS] API分析使用已有气泡缓存 items=' + cachedItemsForLabeling.length);
                }
            }

            raw = await formatWithSecondaryApi(message, cachedItemsForLabeling);
            console.log('[MiniMax TTS] LLM返回:', JSON.stringify(raw).slice(0, 500));
        } else {
            var ct = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
            var rules = (s().regexRules || []).filter(function (r) { return r.enabled; });
            raw = rules.length ? runRegexExtraction(ct, rules, message.name) : [];}

        if (!raw || !raw.length) {
            console.warn('[MiniMax TTS] 未找到可朗读内容');
            return false;
        }

        var isApiLabeledRun = !!s().formatterEnabled;

        var items = raw.map(function (seg) {
            return {
                text: seg.text,
                fullMatch: seg.fullMatch || '',
                speaker: seg.speaker || message.name,
                emotion: seg.emotion || '',
                speed: seg.speed,
                vol: seg.vol,
                pitch: seg.pitch,
                options: buildSynthesisOptions(seg, message),
                serverPath: null,
                apiLabeled: isApiLabeledRun,
            };
        });
        if (false && s().formatterEnabled && message.mes) {
            var origText = message.mes;

            function normText(x) {
                return String(x || '')
                    .replace(/\s+/g, '')
                    .replace(/[""]/g, '"')
                    .replace(/['']/g, "'")
                    .replace(/[（）]/g, function (c) { return c === '（' ? '(' : ')'; })
                    .trim();
            }

            function findFuzzyInOrig(segText) {
                if (!segText) return '';

                // 1. 原文直接匹配
                if (origText.indexOf(segText) >= 0) return segText;

                // 2. 各种包裹符号匹配
                var wraps = [
                    ['\u201c','\u201d'], ['\u300c','\u300d'], ['\u300e','\u300f'], ['\u2018','\u2019'],
                    ['"','"'], ["'","'"],
                    ['(',')'], ['\uff08','\uff09'],
                    ['*','*']
                ];

                for (var wi = 0; wi < wraps.length; wi++) {
                    var wrapped = wraps[wi][0] + segText + wraps[wi][1];
                    if (origText.indexOf(wrapped) >= 0) {
                        // 注意：fullMatch 用segText，更容易在渲染后的DOM里找到
                        return segText;
                    }
                }

                // 3. 去掉首尾包裹符号再匹配
                var trimmed = segText
                    .replace(/^[""「」『』''"'（）()*\s]+/, '')
                    .replace(/[""「」『』''"'（）()*\s]+$/, '');

                if (trimmed && origText.indexOf(trimmed) >= 0) return trimmed;

                // 4. 忽略空白的模糊匹配
                var nSeg = normText(trimmed || segText);
                if (!nSeg) return '';

                var raw = origText;
                var rawNorm = normText(raw);

                if (rawNorm.indexOf(nSeg) >= 0) {
                    // 模糊匹配成功时，返回原始segText，让injectAfterText尝试插入
                    return trimmed || segText;
                }

                // 5. 长句部分匹配，取前12个非空白字符试试
                if (nSeg.length >= 12) {
                    var shortKey = nSeg.slice(0, 12);
                    if (rawNorm.indexOf(shortKey) >= 0) {
                        return trimmed || segText;
                    }
                }

                return '';
            }

            for (var qi = 0; qi < items.length; qi++) {
                if (items[qi].fullMatch) continue;

                var segText = items[qi].text || '';
                var fm = findFuzzyInOrig(segText);

                if (fm) {
                    items[qi].fullMatch = fm;
                    console.log('[MiniMax TTS] 气泡匹配成功#' + qi + ': ' + fm.slice(0, 40));
                } else {
                    console.warn('[MiniMax TTS] 气泡匹配失败#' + qi + ': ' + segText.slice(0, 60));
                }
            }
        }



        console.log('[MiniMax TTS] 生成 ' + items.length + ' 个片段:', items.map(function(it) { return it.speaker + ':' + it.text.slice(0, 20); }));

        if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
        var newVer = { items: items, timestamp: Date.now() };
        if (s().formatterEnabled) newVer._fromFormatter = true;
        s().serverHistory[key].versions.push(newVer);
        s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
        saveSettingsDebounced();
        refreshAllMessageButtons();
        injectBubbles(id);
        return true;
    } catch (e) {
        console.error('[MiniMax TTS] 生成失败:', e);
        toastr.error('生成失败: ' + e.message);
        return false;
    }
}


function extractSegmentsOnly(id) {
    if (!s().showBubbles) return false;
    var data = getMessageData(id);
    var message = data.message, key = data.key;
    if (!message || message.is_system || (s().onlyCharacter && message.is_user)) return false;
    if (s().serverHistory[key] && s().serverHistory[key].versions && s().serverHistory[key].versions.length) return true;
    // 酒馆斜体/Markdown 可能会渲染成 HTML，这里不能直接跳过
    // if (isHtmlMessage(message.mes)) return false;    
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
        btn.classList.toggle('ready', ready);});
}

function makeBubble(mesid, segidx, item, withText) {
    var el = document.createElement('span');
    el.className = 'mm-bubble';
    el.dataset.mesid = mesid;
    el.dataset.segidx = segidx;
    el.title = item.text || '';

    var label = (item.text || '').length > 20 ? (item.text || '').slice(0, 20) + '' : (item.text || '');
    var isEditing = mmInlineEditState && Number(mmInlineEditState.mesid) === Number(mesid);

    el.innerHTML = withText
        ? '<i class="fa-solid fa-volume-low"></i>' + escHtml(label)
        : '<i class="fa-solid fa-volume-low"></i>';

    if (isEditing) {
        el.classList.add('mm-bubble-editing');
        el.title = '编辑模式：点击删除这个气泡';
    }

    if (isBubbleCached(item)) {
        el.classList.add('mm-bubble-cached');
    }

    if (item && item.apiLabeled) {
        el.classList.add('mm-bubble-api-labeled');
        el.title = 'API已分析：'
            + (item.speaker ? item.speaker + ' / ' : '')
            + (item.emotion || '')
            + '\n'
            + (item.text || '');
    }

    return el;
}

function injectAtPlainTextOffset(container, offset, insertEl) {
    if (!container || offset == null || offset < 0) {
        return false;
    }

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
            if (!n.textContent) {
                return NodeFilter.FILTER_REJECT;
            }

            if (n.parentElement && n.parentElement.closest('.mm-bubble,.mm-bubble-strip')) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    var nodes = [];
    var node;

    while ((node = walker.nextNode())) {
        nodes.push(node);
    }

    var count = 0;

    for (var i = 0; i < nodes.length; i++) {
        node = nodes[i];

        var txt = node.textContent || '';
        var next = count + txt.length;

        if (offset <= next) {
            var local = Math.max(0, offset - count);
            var p = node.parentNode;

            if (!p) {
                return false;
            }

            var before = txt.slice(0, local);
            var after = txt.slice(local);

            node.textContent = before;

            var nx = node.nextSibling;
            p.insertBefore(insertEl, nx);

            if (after) {
                p.insertBefore(document.createTextNode(after), insertEl.nextSibling);
            }

            return true;
        }

        count = next;
    }

    return false;
}

function injectAfterExactText(container, searchText, insertEl, occurrence) {
    if (!container || !searchText) {
        return false;
    }

    occurrence = occurrence || 0;

    var target = String(searchText);
    var foundCount = 0;

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
            if (!n.textContent) {
                return NodeFilter.FILTER_REJECT;
            }

            if (n.parentElement && n.parentElement.closest('.mm-bubble,.mm-bubble-strip')) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    var node;

    while ((node = walker.nextNode())) {
        var txt = node.textContent || '';
        var start = 0;
        var idx;

        while ((idx = txt.indexOf(target, start)) >= 0) {
            if (foundCount === occurrence) {
                var endIndex = idx + target.length;
                var p = node.parentNode;

                if (!p) {
                    return false;
                }

                var before = txt.slice(0, endIndex);
                var after = txt.slice(endIndex);

                node.textContent = before;

                var nx = node.nextSibling;
                p.insertBefore(insertEl, nx);

                if (after) {
                    p.insertBefore(document.createTextNode(after), insertEl.nextSibling);
                }

                return true;
            }

            foundCount++;
            start = idx + target.length;
        }
    }

    return false;
}

function injectAfterText(container, searchText, insertEl) {
    if (!searchText) return false;

    function cleanText(t) {
        return String(t || '')
            .replace(/\s+/g, '')
            .replace(/[""]/g, '"')
            .replace(/['']/g, "'")
            .replace(/[「」『』]/g, '')
            .replace(/[（）]/g, function (c) { return c === '（' ? '(' : ')'; })
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .toLowerCase();
    }

    function stripWrap(t) {
        return String(t || '')
            .replace(/^[\s"'""''「」『』（）()*]+/, '')
            .replace(/[\s"'""''「」『』（）()*]+$/, '');
    }

    function makeMap(t) {
        var raw = String(t || '');
        var norm = '';
        var map = [];

        for (var i = 0; i < raw.length; i++) {
            var ch = raw[i];

            if (/\s/.test(ch)) continue;
            if (/[\u200b\u200c\u200d\ufeff]/.test(ch)) continue;

            if (ch === '\u201c' || ch === '\u201d') ch = '"';
            else if (ch === '\u2018' || ch === '\u2019') ch = "'";
            else if (ch === '（') ch = '(';
            else if (ch === '）') ch = ')';

            //渲染后这些符号经常不稳定，模糊匹配时忽略
            if ('「」『』'.indexOf(ch) >= 0) continue;

            norm += ch.toLowerCase();
            map.push(i);
        }

        return { norm: norm, map: map };
    }

    function insertAfterNodeText(node, endIndex) {
        var p = node.parentNode;
        if (!p) return false;

        var text = node.textContent || '';
        var after = text.slice(endIndex);
        node.textContent = text.slice(0, endIndex);

        var nx = node.nextSibling;
        p.insertBefore(insertEl, nx);
        if (after) p.insertBefore(document.createTextNode(after), insertEl.nextSibling);

        return true;
    }

    var rawSearch = String(searchText || '');
    var stripped = stripWrap(rawSearch);

    var candidates = [];

    function addCandidate(x) {
        x = String(x || '').trim();
        if (!x) return;
        if (candidates.indexOf(x) < 0) candidates.push(x);
    }

    addCandidate(rawSearch);

    // 只有 fullMatch 为空或者不是包裹文本时，才尝试 stripped
    // 这样气泡优先放在右引号 / 右星号后面
    if (!/^[\s"'“”‘’「『*]/.test(rawSearch) || !/[\s"'“”‘’」』*]$/.test(rawSearch)) {
        addCandidate(stripped);
    }

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
            if (!n.textContent || !n.textContent.trim()) return NodeFilter.FILTER_REJECT;
            return n.parentElement && n.parentElement.closest('.mm-bubble,.mm-bubble-strip')
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
        },
    });

    var nodes = [];
    var node;
    while ((node = walker.nextNode())) nodes.push(node);

    // 1. 先精确匹配
    for (var ni = 0; ni < nodes.length; ni++) {
        node = nodes[ni];
        var txt = node.textContent || '';

        for (var ci = 0; ci < candidates.length; ci++) {
            var c = candidates[ci];
            var idx = txt.indexOf(c);
            if (idx >= 0) {
                return insertAfterNodeText(node, idx + c.length);
            }
        }
    }

    // 2. 再忽略空白/符号模糊匹配
    for (var ni2 = 0; ni2 < nodes.length; ni2++) {
        node = nodes[ni2];
        var info = makeMap(node.textContent || '');
        if (!info.norm) continue;

        for (var ci2 = 0; ci2 < candidates.length; ci2++) {
            var cand = candidates[ci2];
            var nCand = cleanText(cand);
            if (!nCand || nCand.length < 2) continue;

            var fidx = info.norm.indexOf(nCand);
            if (fidx >= 0) {
                var endOrig = info.map[fidx + nCand.length - 1] + 1;
                return insertAfterNodeText(node, endOrig);
            }
        }
    }

    // 3. 长句部分匹配：取前中后三段，尽量插到能找到的位置
    for (var ni3 = 0; ni3 < nodes.length; ni3++) {
        node = nodes[ni3];
        var info2 = makeMap(node.textContent || '');
        if (!info2.norm) continue;

        for (var ci3 = 0; ci3 < candidates.length; ci3++) {
            var nc = cleanText(candidates[ci3]);
            if (nc.length < 10) continue;

            var keys = [];

            // 前12字
            keys.push(nc.slice(0, 12));

            // 中间12字
            if (nc.length > 20) {
                var mid = Math.floor(nc.length / 2);
                keys.push(nc.slice(Math.max(0, mid - 6), mid + 6));
            }

            // 后12字
            keys.push(nc.slice(Math.max(0, nc.length - 12)));

            for (var ki = 0; ki < keys.length; ki++) {
                var key = keys[ki];
                if (!key || key.length < 6) continue;

                var pidx = info2.norm.indexOf(key);
                if (pidx >= 0) {
                    var endOrig2 = info2.map[pidx + key.length - 1] + 1;
                    console.warn('[MiniMax TTS] 使用部分匹配插入气泡:', key);
                    return insertAfterNodeText(node, endOrig2);
                }
            }
        }
    }

    console.warn('[MiniMax TTS] injectAfterText彻底失败:', searchText);
    return false;
}

function getActiveVersionForMessage(mesid) {
    var data = getMessageData(mesid);
    var h = s().serverHistory[data.key];

    if (!h || !h.versions || !h.versions.length) {
        return null;
    }

    return h.versions[h.activeIndex];
}

function cloneItems(items) {
    return JSON.parse(JSON.stringify(items || []));
}

function pushInlineEditUndo() {
    if (!mmInlineEditState) {
        return;
    }

    if (!mmInlineEditState.undoStack) {
        mmInlineEditState.undoStack = [];
    }

    mmInlineEditState.undoStack.push(cloneItems(mmInlineEditState.workingItems));

    if (mmInlineEditState.undoStack.length > 50) {
        mmInlineEditState.undoStack.shift();
    }
}

function undoInlineBubbleEdit() {
    if (!mmInlineEditState || !mmInlineEditState.undoStack || !mmInlineEditState.undoStack.length) {
        toastr.warning('没有可撤回的操作');
        return;
    }

    var last = mmInlineEditState.undoStack.pop();

    mmInlineEditState.workingItems = cloneItems(last);

    var data = getMessageData(mmInlineEditState.mesid);
    var h = s().serverHistory[data.key];

    if (h && h.versions && h.versions[mmInlineEditState.activeIndex]) {
        h.versions[mmInlineEditState.activeIndex].items = cloneItems(mmInlineEditState.workingItems);
    }

    injectBubbles(mmInlineEditState.mesid);
    toastr.success('已撤回上一步');
}

function openInlineBubbleEditor(mesid) {
    console.log('[MiniMax TTS] 打开行内气泡编辑器 mesid=' + mesid);

    var data = getMessageData(mesid);
    var message = data.message;
    var key = data.key;

    if (!message) {
        toastr.warning('找不到消息');
        return;
    }

    if (!s().serverHistory) {
        s().serverHistory = {};
    }

    var h = s().serverHistory[key];

    if (!h) {
        h = {
            activeIndex: 0,
            versions: [
                {
                    items: [],
                    timestamp: Date.now(),
                    _manualEditor: true,
                },
            ],
        };

        s().serverHistory[key] = h;
    }

    if (!h.versions) {
        h.versions = [];
    }

    if (!h.versions.length) {
        h.versions.push({
            items: [],
            timestamp: Date.now(),
            _manualEditor: true,
        });

        h.activeIndex = 0;
    }

    if (typeof h.activeIndex !== 'number' || !h.versions[h.activeIndex]) {
        h.activeIndex = h.versions.length - 1;
    }

    var activeVer = h.versions[h.activeIndex];

    if (!activeVer.items) {
        activeVer.items = [];
    }

    mmInlineEditState = {
        mesid: mesid,
        key: key,
        activeIndex: h.activeIndex,
        originalItems: cloneItems(activeVer.items),
        workingItems: cloneItems(activeVer.items),
        undoStack: [],
    };

    activeVer.items = cloneItems(mmInlineEditState.workingItems);

    showInlineEditorBar(mesid);
    injectBubbles(mesid);
    saveSettingsDebounced();

    toastr.info('已进入气泡编辑模式：选中文字即可添加气泡，点击气泡可删除');
}



function closeInlineBubbleEditor(save) {
    if (!mmInlineEditState) {
        return;
    }

    var mesid = mmInlineEditState.mesid;
    var data = getMessageData(mesid);
    var h = s().serverHistory[data.key];

    if (h && h.versions && h.versions[mmInlineEditState.activeIndex]) {
        if (save) {
            h.versions[mmInlineEditState.activeIndex].items = cloneItems(mmInlineEditState.workingItems);
            saveSettingsDebounced();
            toastr.success('气泡修改已保存');
        } else {
            h.versions[mmInlineEditState.activeIndex].items = cloneItems(mmInlineEditState.originalItems);
            toastr.warning('已取消修改');
        }
    }

    mmInlineEditState = null;

    var bar = document.getElementById('mm_inline_editor_bar');
    if (bar) {
        bar.remove();
    }

    injectBubbles(mesid);
    refreshBubbleStates(mesid);
    refreshAllMessageButtons();
}

function showInlineEditorBar(mesid) {
    var old = document.getElementById('mm_inline_editor_bar');

    if (old) {
        old.remove();
    }

    var bar = document.createElement('div');
    bar.id = 'mm_inline_editor_bar';
    bar.innerHTML = ''
        + '<div class="mm-inline-editor-title">气泡编辑模式：选中文字添加气泡，点击气泡删除</div>'
        + '<button class="mm-inline-editor-undo">撤回</button>'
        + '<button class="mm-inline-editor-save">保存</button>'
        + '<button class="mm-inline-editor-cancel">取消</button>';

    document.body.appendChild(bar);

    bar.querySelector('.mm-inline-editor-undo').addEventListener('click', function () {
        undoInlineBubbleEdit();
    });

    bar.querySelector('.mm-inline-editor-save').addEventListener('click', function () {
        closeInlineBubbleEditor(true);
    });

    bar.querySelector('.mm-inline-editor-cancel').addEventListener('click', function () {
        closeInlineBubbleEditor(false);
    });
}


function addSelectedTextAsBubble() {
    if (!mmInlineEditState) {
        return;
    }

    var mesid = Number(mmInlineEditState.mesid);
    var sel = window.getSelection();

    if (!sel || sel.rangeCount <= 0) {
        return;
    }

    var selectedText = String(sel.toString() || '').trim();

    if (!selectedText || selectedText.length < 1) {
        return;
    }

    var range = sel.getRangeAt(0);
    var mesEl = document.querySelector('#chat .mes[mesid="' + mesid + '"]');
    var textEl = mesEl ? mesEl.querySelector('.mes_text') : null;

    if (!textEl || !textEl.contains(range.commonAncestorContainer)) {
        return;
    }

    var data = getMessageData(mesid);
    var message = data.message;
    var h = s().serverHistory[data.key];

    if (!h || !h.versions || !h.versions[mmInlineEditState.activeIndex]) {
        return;
    }

    var newItem = {
        text: selectedText,
        fullMatch: selectedText,
        speaker: message.name || '',
        options: buildSynthesisOptions({ text: selectedText, speaker: message.name || '' }, message),
        serverPath: null,
    };

    pushInlineEditUndo();

    mmInlineEditState.workingItems.push(newItem);
    h.versions[mmInlineEditState.activeIndex].items = cloneItems(mmInlineEditState.workingItems);

    sel.removeAllRanges();

    injectBubbles(mesid);
    toastr.success('已添加气泡');
}

function deleteBubbleInInlineEditor(mesid, segidx) {
    if (!mmInlineEditState || Number(mmInlineEditState.mesid) !== Number(mesid)) {
        return;
    }

    var data = getMessageData(mesid);
    var h = s().serverHistory[data.key];

    if (!h || !h.versions || !h.versions[mmInlineEditState.activeIndex]) {
        return;
    }

    segidx = Number(segidx);

    if (segidx < 0 || segidx >= mmInlineEditState.workingItems.length) {
        return;
    }

    pushInlineEditUndo();

    mmInlineEditState.workingItems.splice(segidx, 1);
    h.versions[mmInlineEditState.activeIndex].items = cloneItems(mmInlineEditState.workingItems);

    injectBubbles(mesid);
    toastr.warning('已删除气泡');
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

    textEl.querySelectorAll('.mm-bubble').forEach(function (e) { e.remove(); });
    var oldStrip = textEl.querySelector('.mm-bubble-strip');
    if (oldStrip) oldStrip.remove();
    delete textEl.dataset.mmBubVer;



    var h = s().serverHistory[key];
    var allItems = (h && h.versions && h.versions[h.activeIndex]) ? h.versions[h.activeIndex].items : [];
    var items = [];
    for (var i = 0; i < allItems.length; i++) {
        if (!allItems[i].pauseMs && allItems[i].text) {
            items.push({ it: allItems[i], idx: i });
        }
    }
    if (!items.length) return;

    var inlineItems = [], stripItems = [];
    for (var si = 0; si < items.length; si++) {
        if (items[si].it.fullMatch) inlineItems.push(items[si]);
        else stripItems.push(items[si]);
    }

    var occurrenceMap = {};
    var fallbackOccurrenceMap = {};
    var renderedTextMap = {};

    for (var mi = 0; mi < inlineItems.length; mi++) {
        var inItem = inlineItems[mi].it;
        var textKey = String(inItem.text || '').replace(/\s+/g, ' ').trim();
        var fm = String(inItem.fullMatch || '').replace(/\s+/g, ' ').trim();

        if (!textKey) {
            continue;
        }

        // 防止同一段斜体内容被 *内容* 和 <em>内容</em> 同时提取后重复渲染
        if (renderedTextMap[textKey]) {
            console.warn('[MiniMax TTS] 跳过重复气泡文本:', textKey);
            continue;
        }

        var inBub = makeBubble(mesid, inlineItems[mi].idx, inItem, false);
        var inserted = false;

        if (fm) {
            var occ = occurrenceMap[fm] || 0;
            occurrenceMap[fm] = occ + 1;

            inserted = injectAfterExactText(textEl, fm, inBub, occ);
        }

        // 只有酒馆斜体/HTML斜体这种 fullMatch 页面上不存在的情况，才允许用内部文本定位
        var canFallbackToText = /^<\s*(em|i)\b[\s\S]*<\/\s*(em|i)\s*>$/i.test(fm)
            || /^\*[\s\S]*\*$/.test(fm);

        if (!inserted && textKey && canFallbackToText) {
            var textOcc = fallbackOccurrenceMap[textKey] || 0;
            fallbackOccurrenceMap[textKey] = textOcc + 1;

            inserted = injectAfterExactText(textEl, textKey, inBub, textOcc);
        }

        if (inserted) {
            renderedTextMap[textKey] = true;
        } else {
            console.warn('[MiniMax TTS] 未找到精确文本，跳过气泡:', fm || textKey);
        }
    }


    // 不再显示底部兜底气泡，避免未定位片段生成一大堆气泡
    if (stripItems.length) {
        console.warn('[MiniMax TTS] 跳过未定位气泡数量:', stripItems.length);
    }

    textEl.dataset.mmBubVer = key + ':' + (h ? h.activeIndex : 0) + ':' + items.length;
}


function removeAllBubbles() {
    document.querySelectorAll('.mm-bubble,.mm-bubble-strip').forEach(function (e) {
        e.remove();
    });
    document.querySelectorAll('[data-mm-bub-ver]').forEach(function (e) {
        e.removeAttribute('data-mm-bub-ver');
    });
}


function refreshAllBubbles() {
    removeAllBubbles();

    if (!s().showBubbles) {
        return;
    }

    document.querySelectorAll('#chat .mes[mesid]').forEach(function (el) {
        var id = Number(el.getAttribute('mesid'));
        var data = getMessageData(id);

        // 只显示已经有缓存的气泡，不再自动给所有正文跑正则提取
        if (data.key && s().serverHistory[data.key]) {
            injectBubbles(id);
        }
    });
}



//═══════════════ 操作菜单 ═══════════════

function closeActionMenu() {
    var m = document.querySelector('.mm-action-menu');
    if (m) m.remove();
}

function showActionMenu(mesid, anchorEl) {
    closeActionMenu();

    var data = getMessageData(mesid);
    var hasCache = !!(s().serverHistory[data.key] && s().serverHistory[data.key].versions && s().serverHistory[data.key].versions.length);

    var menu = document.createElement('div');
    menu.className = 'mm-action-menu';

    var btns = [
        { icon: 'fa-solid fa-quote-left', label: '正则提取', id: 'regex' },
        { icon: 'fa-solid fa-robot', label: 'API分析', id: 'api' },
        { icon: 'fa-solid fa-pen', label: '编辑器', id: 'editor' },
        { icon: 'fa-solid fa-rotate', label: '重新分析', id: 'reanalyze' },
        { icon: 'fa-solid fa-gear', label: '设置面板', id: 'settings' },
        { icon: 'fa-solid fa-trash', label: '清除缓存', id: 'clear', need: true, danger: true },
    ];

    for (var i = 0; i < btns.length; i++) {
        var b = btns[i];

        var btn = document.createElement('button');
        btn.className = 'mm-action-btn' + (b.danger ? ' mm-btn-danger' : '');

        if (b.need && !hasCache) {
            btn.className += ' mm-action-btn-disabled';
            btn.disabled = true;
            btn.title = '请先正则提取或API分析生成缓存';
        }

        btn.innerHTML = '<i class="' + b.icon + '"></i>' + b.label;
        btn.dataset.action = b.id;
        btn.dataset.mesid = mesid;

        if (!btn.disabled) {
            btn.addEventListener('click', handleActionClick);
        }

        menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    // 定位
    var rect = anchorEl.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;

    var preferRight = anchorEl && anchorEl.id === 'mm_fab';

    var left;

    if (preferRight) {
        // 悬浮按钮菜单优先显示在按钮右侧
        left = rect.right + 8;

        // 如果右侧空间不够，就贴近右边界，避免超出屏幕
        if (left + mw > window.innerWidth - 8) {
            left = window.innerWidth - mw - 8;
        }
    } else {
        // 消息旁边的小喇叭菜单保持原逻辑：优先显示在左侧
        left = rect.left - mw - 8;

        if (left < 8) {
            left = rect.right + 8;
        }

        if (left + mw > window.innerWidth - 8) {
            left = window.innerWidth - mw - 8;
        }
    }

    var top = rect.top + rect.height / 2 - mh / 2;

    if (top < 8) {
        top = 8;
    }

    if (top + mh > window.innerHeight - 8) {
        top = window.innerHeight - mh - 8;
    }

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.position = 'fixed';

    // 点外面关闭
    setTimeout(function () {
        document.addEventListener('click', onOutsideClick);
        document.addEventListener('scroll', closeActionMenu, true);
    }, 50);
}

function onOutsideClick(e) {
    if (e.target.closest && e.target.closest('.mm-action-menu')) return;
    closeActionMenu();document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('scroll', closeActionMenu, true);
}

async function handleActionClick(e) {
    var action = this.dataset.action;
    var mesid = Number(this.dataset.mesid);
    closeActionMenu();

    var data = getMessageData(mesid);

    switch (action) {
        case 'regex':
            // 只用正则提取，不调LLM
            var origEnabled = s().formatterEnabled;
            s().formatterEnabled = false;
            await generateMessageSpeech(mesid, true);
            s().formatterEnabled = origEnabled;
            injectBubbles(mesid);
            toastr.success('正则提取完成');
            break;

        case 'api':
            toastr.info('API分析中...');
            ttsLog('菜单: API分析开始');

            var oldFormatterEnabled = s().formatterEnabled;
            s().formatterEnabled = true;

            try {
                if (await generateMessageSpeech(mesid, true)) {
                    injectBubbles(mesid);
                    ttsLog('菜单: API分析完成', 'success');
                    toastr.success('API分析完成');
                } else {
                    ttsLog('菜单: API分析没有生成结果', 'warn');
                    toastr.warning('API分析没有生成结果，请检查LLM预设和日志');
                }
            } finally {
                s().formatterEnabled = oldFormatterEnabled;
            }

            break;

        case 'editor':
            toastr.info('正在打开编辑器...');
            openInlineBubbleEditor(mesid);
            break;

        case 'reanalyze':
            // 重新分析：保留气泡文本，只清掉音频和API黄色标记
            if (s().serverHistory[data.key]) {
                if (!s()._undoHistory) {
                    s()._undoHistory = {};
                }

                s()._undoHistory[data.key] = JSON.parse(JSON.stringify(s().serverHistory[data.key]));

                var h = s().serverHistory[data.key];

                if (h && h.versions && h.versions.length) {
                    for (var ri = 0; ri < h.versions.length; ri++) {
                        var ver = h.versions[ri];

                        if (!ver || !ver.items) {
                            continue;
                        }

                        for (var rj = 0; rj < ver.items.length; rj++) {
                            var item = ver.items[rj];

                            if (!item) {
                                continue;
                            }

                            // 清掉音频缓存路径
                            item.serverPath = null;

                            // 清掉API标记，让黄色变回绿色
                            item.apiLabeled = false;

                            // 顺便清理可能存在的旧标记
                            delete item.apiLabeled;
                        }
                    }
                }

                saveSettingsDebounced();
                injectBubbles(mesid);
                refreshAllMessageButtons();

                toastr.success('已清除音频和API标记，正则气泡已保留');
            } else {
                toastr.warning('没有可处理的缓存');
            }

            break;

        case 'settings':
            if (typeof openConfigPanel === 'function') {
                openConfigPanel();
            } else {
                $('#mm_wand_item').trigger('click');
            }
            break;

        case 'clear':
            if (!s()._undoHistory) s()._undoHistory = {};
            s()._undoHistory[data.key] = JSON.parse(JSON.stringify(s().serverHistory[data.key] || {}));
            delete s().serverHistory[data.key];
            saveSettingsDebounced();
            injectBubbles(mesid);
            refreshAllMessageButtons();
            toastr.success('缓存已清除');
            break;
    }
}
//═══════════════ 内嵌编辑器 ═══════════════

var editingMesId = null;

function enterEditMode(mesid) {
    exitEditMode();
    editingMesId = mesid;

    var mesEl = document.querySelector('#chat .mes[mesid="' + mesid + '"]');
    if (!mesEl) return;
    var textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return;

    textEl.classList.add('mm-editing');

    // 给每个气泡加删除按钮
    textEl.querySelectorAll('.mm-bubble').forEach(function (bub) {
        if (bub.querySelector('.mm-bubble-del')) return;
        var del = document.createElement('span');
        del.className = 'mm-bubble-del';
        del.innerHTML = '×';
        del.addEventListener('click', function (e) {
            e.stopPropagation();
            var idx = Number(bub.dataset.segidx);
            deleteBubbleItem(mesid, idx);
        });
        bub.appendChild(del);
    });

    // 监听文字选中
    textEl.addEventListener('mouseup', onEditSelect);
    textEl.addEventListener('touchend', onEditSelect);

    toastr.info('编辑模式：点×删除气泡，选中文字添加气泡。点消息外部退出。');

    // 点外面退出
    setTimeout(function () {
        document.addEventListener('click', onEditOutsideClick);
    }, 100);
}

function exitEditMode() {
    if (editingMesId === null) return;
    var mesEl = document.querySelector('#chat .mes[mesid="' + editingMesId + '"]');
    if (mesEl) {
        var textEl = mesEl.querySelector('.mes_text');
        if (textEl) {
            textEl.classList.remove('mm-editing');
            textEl.removeEventListener('mouseup', onEditSelect);
            textEl.removeEventListener('touchend', onEditSelect);
        }
    }
    var addBtn = document.querySelector('.mm-add-bubble-btn');
    if (addBtn) addBtn.remove();
    document.removeEventListener('click', onEditOutsideClick);
    editingMesId = null;
}

function onEditOutsideClick(e) {
    if (!editingMesId) return;
    var mesEl = document.querySelector('#chat .mes[mesid="' + editingMesId + '"]');
    if (mesEl && mesEl.contains(e.target)) return;
    if (e.target.closest('.mm-add-bubble-btn')) return;
    if (e.target.closest('.mm-action-menu')) return;
    exitEditMode();
}

function onEditSelect(e) {
    // 移除旧的添加按钮
    var old = document.querySelector('.mm-add-bubble-btn');
    if (old) old.remove();

    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

    var selectedText = sel.toString().trim();
    if (selectedText.length < 1) return;

    var range = sel.getRangeAt(0);
    var rect = range.getBoundingClientRect();

    var btn = document.createElement('div');
    btn.className = 'mm-add-bubble-btn';
    btn.innerHTML = '<i class="fa-solid fa-plus"></i> 添加气泡';
    btn.style.left = (rect.left + rect.width / 2 - 50) + 'px';
    btn.style.top = (rect.top - 32) + 'px';
    document.body.appendChild(btn);

    btn.addEventListener('click', function () {
        btn.remove();
        addBubbleFromSelection(editingMesId, selectedText);sel.removeAllRanges();
    });
}

function deleteBubbleItem(mesid, segidx) {
    var data = getMessageData(mesid);
    var h = s().serverHistory[data.key];
    if (!h || !h.versions || !h.versions[h.activeIndex]) return;

    var items = h.versions[h.activeIndex].items;
    if (segidx >= 0 && segidx < items.length) {
        var removed = items[segidx];
        console.log('[MiniMax TTS] 删除气泡#' + segidx + ':', removed.text.slice(0, 30));
        items.splice(segidx, 1);
        saveSettingsDebounced();

        // 重新注入
        var wasEditing = editingMesId === mesid;
        exitEditMode();
        injectBubbles(mesid);
        refreshAllMessageButtons();
        if (wasEditing) enterEditMode(mesid);
    }
}

function addBubbleFromSelection(mesid, selectedText) {
    var data = getMessageData(mesid);
    var message = data.message;
    if (!message) return;

    var key = data.key;
    if (!s().serverHistory[key]) {
        s().serverHistory[key] = { activeIndex: 0, versions: [] };
    }
    var h = s().serverHistory[key];
    if (!h.versions.length) {
        h.versions.push({ items: [], timestamp: Date.now() });
        h.activeIndex = 0;
    }

    var items = h.versions[h.activeIndex].items;

    // 查找说话人
    var speaker = message.name || '未知';
    if (items.length > 0) {
        speaker = items[items.length - 1].speaker || speaker;
    }

    var newItem = {
        text: selectedText,
        fullMatch: selectedText,
        speaker: speaker,
        options: buildSynthesisOptions({ text: selectedText, speaker: speaker }, message),
        serverPath: null,
    };

    items.push(newItem);
    saveSettingsDebounced();

    console.log('[MiniMax TTS] 添加气泡:', selectedText.slice(0, 30), '说话人:', speaker);

    // 重新注入
    var wasEditing = editingMesId === mesid;
    exitEditMode();
    injectBubbles(mesid);
    refreshAllMessageButtons();
    if (wasEditing) enterEditMode(mesid);
    toastr.success('已添加气泡');
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
        $('#minimax_quote_tts_editor .editor-confirm').on('click', function () { saveSettingsDebounced(); $('#minimax_quote_tts_editor').remove(); refreshAllMessageButtons(); inv(); });$('#minimax_quote_tts_editor select.edit-v').each(function () { $(this).val(v.items[$(this).data('idx')].options.model); });
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
    st.textContent = '.mm-config-mask{display:none;position:fixed;inset:0;z-index:2147483001!important;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);justify-content:center;align-items:center;padding:16px}.mm-config-mask.mm-config-open{display:flex!important}.mm-config-dialog{width:min(680px,96vw);max-height:92vh;background:var(--SmartThemeBlurTintColor,#1a1c2a);color:var(--SmartThemeBodyColor,#ccc);border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}.mm-config-header{display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;gap:8px}.mm-config-close{background:none;border:none;color:inherit;font-size:1.2rem;cursor:pointer;padding:4px 8px;opacity:.6;flex-shrink:0}.mm-config-close:hover{opacity:1}.mm-config-body{flex:1;overflow-y:auto;padding:16px}.mm-tab-bar{display:flex;gap:2px;flex:1;flex-wrap:wrap}.mm-tab{background:transparent;border:none;color:inherit;padding:6px 14px;cursor:pointer;border-radius:8px 8px 0 0;font-size:.88rem;opacity:.55;white-space:nowrap}.mm-tab:hover{opacity:.8;background:rgba(255,255,255,.04)}.mm-tab.active{opacity:1;background:rgba(255,255,255,.08);font-weight:600}.mm-tab-panel{display:none}.mm-tab-panel.active{display:block}.mm-config-dialog .mm-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}.mm-config-dialog .mm-row>label{min-width:85px;flex-shrink:0;font-size:.88rem;opacity:.8}.mm-config-dialog .text_pole{flex:1;min-width:0;max-width:100%;box-sizing:border-box;height:34px!important;font-size:.88rem!important}.mm-config-dialog textarea.text_pole{height:auto!important;min-height:64px;resize:vertical}.mm-config-dialog select.text_pole{flex:1;min-width:0}.mm-config-dialog input[type=checkbox]{flex:none;width:18px;height:18px}.mm-section-title{font-weight:600;font-size:.95rem;margin:16px 0 8px;display:flex;align-items:center;gap:10px}.mm-desc{font-size:.82rem;opacity:.55;margin:0 0 10px;line-height:1.4}.mm-inline-hint{font-size:.78rem;opacity:.45;margin-left:6px}.mm-voice-lib-row,.mm-binding-row,.mm-rule-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}.mm-rule-header-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:.78rem;opacity:.45}.mm-rule-header-row>span{flex:1}.mm-bubble-strip{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.08)}.mm-bubble{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:rgba(76,175,80,.15);color:var(--SmartThemeBodyColor,#ccc);font-size:.82rem;cursor:pointer;transition:background .15s;user-select:none;vertical-align:middle;margin:0 2px}.mm-bubble:hover{background:rgba(76,175,80,.3)}.mm-bubble i{font-size:.72rem;opacity:.6}.mm-bubble-cached{background:rgba(33,150,243,.15)}.mm-bubble-cached:hover{background:rgba(33,150,243,.3)}.mm-bubble-loading{opacity:.5;pointer-events:none}.mm-bubble-playing{background:rgba(255,152,0,.2);animation:mm-pulse .8s infinite alternate}@keyframes mm-pulse{from{opacity:.7}to{opacity:1}}.mes_quote_tts{cursor:pointer;opacity:.5;transition:opacity .15s}.mes_quote_tts:hover{opacity:1}.mes_quote_tts.ready{color:#4caf50;opacity:.8}.minimax-tts-editor-mask{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);display:flex;justify-content:center;align-items:center;padding:16px}.minimax-tts-editor-dialog{width:min(720px,96vw);max-height:90vh;background:var(--SmartThemeBlurTintColor,#1a1c2a);color:var(--SmartThemeBodyColor,#ccc);border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}.minimax-tts-editor-header{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);gap:12px}.minimax-tts-editor-body{flex:1;overflow-y:auto;padding:16px}.minimax-tts-editor-item{padding:12px;margin-bottom:12px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}.minimax-tts-editor-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.minimax-tts-editor-row-flex{display:flex;align-items:center;gap:6px}.minimax-tts-editor-row-flex label{min-width:40px;font-size:.82rem;opacity:.6}.minimax-tts-editor-actions{display:flex;gap:12px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08)}.minimax-tts-editor-actions .menu_button{flex:1}.mm-fab-wrap{position:fixed;right:24px;bottom:80px;z-index:2147483000}.mm-fab{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#4caf50,#2196f3);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.35);transition:transform .15s,box-shadow .15s;touch-action:none;user-select:none}.mm-fab:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(0,0,0,.45)}.mm-fab.generating{animation:mm-fab-spin 1.2s linear infinite}@keyframes mm-fab-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.mm-fab img{width:36px;height:36px;border-radius:50%;object-fit:cover;pointer-events:none}';
    st.textContent += `
#mm_mobile_float_btn{
    display:none!important;
}
#mm_mobile_float_btn:hover{
    display:none!important;
}

@media screen and (max-width: 700px){
    #mm_mobile_float_btn{
        display:none!important;
    }

    .mm-config-mask{
        z-index:2147483001!important;
        align-items:flex-start!important;
        justify-content:center!important;
        padding:calc(env(safe-area-inset-top, 0px) + 48px) 8px 8px 8px!important;
        box-sizing:border-box!important;
    }

    .mm-config-dialog{
        width:calc(100vw - 16px)!important;
        max-width:calc(100vw - 16px)!important;
        height:calc(100dvh - env(safe-area-inset-top, 0px) - 64px)!important;
        max-height:calc(100dvh - env(safe-area-inset-top, 0px) - 64px)!important;border-radius:12px!important;
    }

    .mm-config-header{
        padding:8px 10px!important;
        gap:4px!important;
    }

    .mm-tab{
        padding:6px 8px!important;
        font-size:.78rem!important;
    }

    .mm-config-body{
        padding:10px!important;
    }

    .mm-config-dialog .mm-row{
        flex-wrap:wrap!important;
        align-items:flex-start!important;
        gap:6px!important;
    }

    .mm-config-dialog .mm-row>label{
        min-width:72px!important;
        font-size:.8rem!important;
    }

    .mm-config-dialog .text_pole{
        min-width:0!important;
        font-size:.82rem!important;
    }

    .mm-binding-row,
    .mm-voice-lib-row,
    .mm-rule-row{
        flex-wrap:wrap!important;}

    .minimax-tts-editor-dialog{
        width:calc(100vw - 16px)!important;
        max-width:calc(100vw - 16px)!important;
        height:calc(100dvh - 32px)!important;
        max-height:calc(100dvh - 32px)!important;}
}
`;
st.textContent += `
.mm-action-menu{
    position:absolute;
    z-index:2147483002;
    display:flex;
    flex-direction:column;
    gap:6px;
    padding:8px;
    background:rgba(18,20,32,.98);
    backdrop-filter:blur(12px);
    border-radius:14px;
    box-shadow:0 8px 32px rgba(0,0,0,.65);
    min-width:150px;
    animation:mm-menu-in .15s ease;
}

@keyframes mm-menu-in{
    from{
        opacity:0;
        transform:scale(.9) translateY(6px);
    }
    to{
        opacity:1;
        transform:none;
    }
}

.mm-action-btn{
    display:flex;
    align-items:center;
    gap:8px;
    padding:9px 14px;
    border-radius:10px;
    background:rgba(255,255,255,.16);
    color:#ffffff;
    border:none;
    cursor:pointer;
    font-size:.88rem;
    font-weight:600;
    white-space:nowrap;
    transition:background .12s, transform .12s;
}

.mm-action-menu {
    background: rgba(42, 32, 24, 0.94) !important;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.48) !important;
    border: none !important;
}

.mm-action-btn {
    background: #f4ead8 !important;
    color: #5a341e !important;
    border: none !important;
    outline: none !important;
    font-weight: 700 !important;
    text-shadow: none !important;
}

.mm-action-btn:hover {
    background: #fff3dc !important;
    color: #3f220f !important;
}

.mm-action-btn i {
    color: #7a4a28 !important;
    opacity: 1 !important;
}

.mm-action-btn.mm-btn-danger {
    background: #f4ead8 !important;
    color: #9b2f24 !important;
}

.mm-action-btn.mm-btn-danger i {
    color: #9b2f24 !important;
}

.mm-action-btn.mm-btn-danger:hover {
    background: #ffe1d8 !important;
    color: #7f1f17 !important;
}

.mm-action-btn:hover{
    background:rgba(255,255,255,.28);
    transform:translateX(2px);
}

.mm-action-btn i{
    width:18px;
    text-align:center;
    font-size:.95rem;
    opacity:1;
}

.mm-action-btn.mm-btn-danger{
    color:#ff6b6b;
    background:rgba(255,80,80,.16);
}

.mm-action-btn.mm-btn-danger:hover{
    background:rgba(255,80,80,.28);
}

.mm-action-btn-disabled,
.mm-action-btn:disabled{
    opacity:.45;
    cursor:not-allowed;
    transform:none!important;
}

.mm-action-btn-disabled:hover,
.mm-action-btn:disabled:hover{
    background:rgba(255,255,255,.16);
    transform:none!important;
}
.mm-editing .mm-bubble{
    position:relative;
    padding-right:22px;
    border:1px dashed rgba(255,255,255,.2);
}
.mm-bubble-del{
    position:absolute;right:2px;top:50%;transform:translateY(-50%);
    width:16px;height:16px;border-radius:50%;
    background:rgba(239,83,80,.7);color:#fff;
    font-size:10px;line-height:16px;text-align:center;
    cursor:pointer;display:none;
}
.mm-editing .mm-bubble-del{display:block}
.mm-bubble-del:hover{background:#ef5350}
.mm-add-bubble-btn{
    position:absolute;z-index:2147483003;
    padding:4px 12px;border-radius:8px;
    background:rgba(76,175,80,.9);color:#fff;
    font-size:.82rem;cursor:pointer;
    box-shadow:0 4px 12px rgba(0,0,0,.3);
    animation:mm-menu-in .12s ease;
}
.mm-add-bubble-btn:hover{background:#4caf50}
.mm-editing .mm-bubble-strip{
    border:1px dashed rgba(255,255,255,.15);
    border-radius:8px;
    padding:8px;
}
#mm_inline_editor_bar {
    position: fixed !important;
    left: 50% !important;
    bottom: 24px !important;
    transform: translateX(-50%) !important;
    z-index: 2147483600 !important;

    display: flex !important;
    align-items: center !important;
    gap: 10px !important;

    padding: 10px 12px !important;
    border-radius: 999px !important;
    background: rgba(42, 32, 24, 0.96) !important;
    color: #fff7e8 !important;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45) !important;
    font-size: 13px !important;
}

.mm-inline-editor-title {
    white-space: nowrap !important;
    opacity: 0.95 !important;
}

.mm-inline-editor-undo,
.mm-inline-editor-save,
.mm-inline-editor-cancel {
    border: none !important;
    outline: none !important;
    border-radius: 999px !important;
    padding: 6px 12px !important;
    cursor: pointer !important;
    font-weight: 700 !important;
}
    border: none !important;
    outline: none !important;
    border-radius: 999px !important;
    padding: 6px 12px !important;
    cursor: pointer !important;
    font-weight: 700 !important;
}

.mm-inline-editor-save {
    background: #f4ead8 !important;
    color: #5a341e !important;
}

.mm-inline-editor-cancel {
    background: rgba(255, 255, 255, 0.16) !important;
    color: #ffffff !important;
}

.mm-bubble-editing {
    position: relative !important;
    padding-right: 16px !important;
    outline: 1px dashed rgba(122, 74, 40, 0.55) !important;
}

.mm-bubble-del {
    position: absolute !important;
    right: -7px !important;
    top: -8px !important;

    width: 16px !important;
    height: 16px !important;
    line-height: 14px !important;

    border: none !important;
    border-radius: 50% !important;
    padding: 0 !important;

    background: #b43b2f !important;
    color: #ffffff !important;
    font-size: 12px !important;
    font-weight: 800 !important;
    cursor: pointer !important;
    z-index: 2 !important;
}
.mm-bubble.mm-bubble-api-labeled {
    background: rgba(255, 236, 150, 0.88) !important;
    border-color: rgba(230, 180, 70, 0.95) !important;
    color: #6a4a00 !important;
    box-shadow: 0 0 0 1px rgba(255, 210, 90, 0.45) !important;
}

.mm-bubble.mm-bubble-api-labeled i {
    color: #7a5600 !important;
}

`;

//===== [修改] 新增：悬浮快捷菜单 CSS =====
st.textContent += `
.mm-mob-menu{
    position:fixed;
    z-index:2147483001;
    display:flex;
    flex-direction:column-reverse;
    gap:10px;
    animation:mm-mob-menu-in .2s ease;
}
@keyframes mm-mob-menu-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.mm-mob-menu-item{
    display:flex;
    align-items:center;
    gap:8px;
    white-space:nowrap;
    cursor:pointer;
    user-select:none;
}
.mm-mob-menu-icon{
    width:40px;
    height:40px;
    border-radius:50%;
    display:flex;
    align-items:center;
    justify-content:center;
    font-size:16px;
    color:#fff;
    box-shadow:0 3px 12px rgba(0,0,0,.35);
    flex-shrink:0;
    transition:transform .12s;
}
.mm-mob-menu-icon:active{transform:scale(.9)}
.mm-mob-menu-label{
    background:rgba(30,32,48,.92);
    backdrop-filter:blur(8px);
    color:#ddd;
    padding:5px 12px;
    border-radius:8px;
    font-size:.82rem;
    box-shadow:0 3px 12px rgba(0,0,0,.3);
    pointer-events:none;
}
.mm-mob-menu-backdrop{
    position:fixed;
    inset:0;
    z-index:2147483000;
    background:rgba(0,0,0,.25);
    animation:mm-mob-backdrop-in .15s ease;
}
@keyframes mm-mob-backdrop-in{from{opacity:0}to{opacity:1}}

#mm_fab_wrap,
.mm-fab-wrap {
    width: 52px !important;
    height: 52px !important;
    min-width: 52px !important;
    min-height: 52px !important;
    max-width: 52px !important;
    max-height: 52px !important;
}

#mm_fab,
.mm-fab {
    width: 52px !important;
    height: 52px !important;
    min-width: 52px !important;
    min-height: 52px !important;
    max-width: 52px !important;
    max-height: 52px !important;

    padding: 0 !important;
    margin: 0 !important;

    background: transparent !important;
    background-color: transparent !important;

    border: none !important;
    outline: none !important;
    box-shadow: none !important;

    color: #ffffff !important;
    font-size: 30px !important;
    line-height: 1 !important;

    display: flex !important;
    align-items: center !important;
    justify-content: center !important;

    overflow: hidden !important;
}

#mm_fab:hover,
.mm-fab:hover {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
}

#mm_fab.generating,
.mm-fab.generating {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
}

#mm_fab i,
.mm-fab i {
    font-size: 30px !important;
    width: auto !important;
    height: auto !important;
    line-height: 1 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
}

#mm_fab img,
.mm-fab img {
    width: 52px !important;
    height: 52px !important;
    min-width: 52px !important;
    min-height: 52px !important;
    max-width: 52px !important;
    max-height: 52px !important;

    object-fit: cover !important;
    object-position: center center !important;

    transform: scale(1.18) !important;
    transform-origin: center center !important;

    display: block !important;
    padding: 0 !important;
    margin: 0 !important;
}



.mm-action-menu {
    background: rgba(42, 32, 24, 0.94) !important;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.48) !important;
    border: none !important;
}

.mm-action-btn {
    background: #f4ead8 !important;
    color: #5a341e !important;
    border: none !important;
    outline: none !important;
    font-weight: 700 !important;
    text-shadow: none !important;
}

.mm-action-btn:hover {
    background: #fff3dc !important;
    color: #3f220f !important;
}

.mm-action-btn i {
    color: #7a4a28 !important;
    opacity: 1 !important;
}

.mm-action-btn.mm-btn-danger {
    background: #f4ead8 !important;
    color: #9b2f24 !important;
}

.mm-action-btn.mm-btn-danger i {
    color: #9b2f24 !important;
}

.mm-action-btn.mm-btn-danger:hover {
    background: #ffe1d8 !important;
    color: #7f1f17 !important;
}

.mm-inline-editor-undo {
    background: #d8b98b !important;
    color: #4a2a13 !important;
}

.mm-bubble-editing {
    cursor: pointer !important;
    outline: 1px dashed rgba(122, 74, 40, 0.75) !important;
    background: rgba(244, 234, 216, 0.28) !important;
}

`;
    // ===== [覆盖] 去掉绿色旧按钮，并把 mm_fab 改成非绿色样式 =====
    st.textContent += `
#mm_mobile_float_btn {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

#mm_mobile_float_btn:hover {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

#mm_mobile_float_btn::before,
#mm_mobile_float_btn::after {
    display: none !important;
}

#mm_fab {
    width: 58px !important;
    height: 58px !important;
    min-width: 58px !important;
    min-height: 58px !important;
    max-width: 58px !important;
    max-height: 58px !important;

    background: transparent !important;
    background-color: transparent !important;
    color: #ffffff !important;

    border: none !important;
    outline: none !important;
    box-shadow: none !important;

    font-size: 30px !important;
    line-height: 58px !important;

    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}

#mm_fab:hover {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
}

#mm_fab.generating {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
}


#mm_fab:hover {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
}

#mm_fab.generating {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
}


#mm_fab.generating {
    background: rgba(45, 48, 70, 0.96) !important;
    background-color: rgba(45, 48, 70, 0.96) !important;
}

@media screen and (max-width: 700px) {
    #mm_mobile_float_btn {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
    }
}
`;

    // ===== [修改结束] =====
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
    var c = document.getElementById('mm_rule_rows');
    if (!c) return;
    c.innerHTML = '';

    (s().regexRules || []).forEach(function (r, i) {
        if (!r.flags) r.flags = 'g';

        var el = document.createElement('div');
        el.className = 'mm-rule-row';
        el.innerHTML =
            '<input type="checkbox" class="mm-rule-toggle" ' + (r.enabled ? 'checked' : '') + '>'
            + '<input class="text_pole mm-rule-name" placeholder="规则名" value="' + escHtml(r.name || '') + '">'
            + '<input class="text_pole mm-rule-pattern" placeholder="正则" value="' + escHtml(r.pattern || '') + '">'
            + '<input class="text_pole mm-rule-flags" placeholder="flags" value="' + escHtml(r.flags || 'g') + '" style="max-width:60px">'
            + '<select class="text_pole mm-rule-mode" style="max-width:68px">'
            + '<option value="extract" ' + (r.mode === 'extract' ? 'selected' : '') + '>提取</option>'
            + '<option value="exclude" ' + (r.mode === 'exclude' ? 'selected' : '') + '>排除</option>'
            + '</select>'
            + '<button class="menu_button mm-rule-del" style="padding:4px 10px;flex-shrink:0">×</button>';
        el.querySelector('.mm-rule-toggle').addEventListener('change', function () { s().regexRules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input', function () { s().regexRules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function () { s().regexRules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-flags').addEventListener('input', function () { s().regexRules[i].flags = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change', function () { s().regexRules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click', function () { s().regexRules.splice(i, 1); renderRules(); saveSettingsDebounced(); });
        c.appendChild(el);
    });
}

function renderRegexPresets() {
    var sel = document.getElementById('mm_regex_presets');
    if (!sel) return;
    sel.innerHTML = '<option value="-1">--选择预设--</option>';
    (s().regexPresets || []).forEach(function (p, i) {
        var o = document.createElement('option'); o.value = i; o.textContent = p.name; sel.appendChild(o);
    });
}

function renderPreProcessRules() {
    var c = document.getElementById('mm_pre_rule_rows');
    if (!c) return;
    c.innerHTML = '';

    (s().llmPreProcessRules || []).forEach(function (r, i) {
        if (!r.flags) r.flags = 'g';

        var el = document.createElement('div');
        el.className = 'mm-rule-row';
        el.innerHTML =
            '<input type="checkbox" class="mm-pre-rule-toggle" ' + (r.enabled ? 'checked' : '') + '>'
            + '<input class="text_pole mm-pre-rule-name" placeholder="规则名" value="' + escHtml(r.name || '') + '">'
            + '<input class="text_pole mm-pre-rule-pattern" placeholder="正则" value="' + escHtml(r.pattern || '') + '">'
            + '<input class="text_pole mm-pre-rule-flags" placeholder="flags" value="' + escHtml(r.flags || 'g') + '" style="max-width:60px">'
            + '<select class="text_pole mm-pre-rule-mode" style="max-width:68px">'
            + '<option value="extract" ' + (r.mode === 'extract' ? 'selected' : '') + '>提取</option>'
            + '<option value="exclude" ' + (r.mode === 'exclude' ? 'selected' : '') + '>排除</option>'
            + '</select>'
            + '<button class="menu_button mm-pre-rule-del" style="padding:4px 10px;flex-shrink:0">×</button>';
        el.querySelector('.mm-pre-rule-toggle').addEventListener('change', function () { s().llmPreProcessRules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-pre-rule-name').addEventListener('input', function () { s().llmPreProcessRules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-pre-rule-pattern').addEventListener('input', function () { s().llmPreProcessRules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-pre-rule-flags').addEventListener('input', function () { s().llmPreProcessRules[i].flags = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-pre-rule-mode').addEventListener('change', function () { s().llmPreProcessRules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-pre-rule-del').addEventListener('click', function () { s().llmPreProcessRules.splice(i, 1); renderPreProcessRules(); saveSettingsDebounced(); });
        c.appendChild(el);
    });
}

function renderBindings() {
    var c = document.getElementById('mm_b_rows'); if (!c) return; c.innerHTML = '';
    var ctx = getContext(), cid = ctx.characterId || ctx.character_id || ctx.name2|| 'global';
    var list = s().characterBindingsMap[cid] || [];

    list.forEach(function (b, i) {
        var el = document.createElement('div'); el.className = 'mm-binding-row';
        el.innerHTML =
            '<select class="text_pole mm-b-type" style="max-width:120px">'
            + '<option value="' + TARGET_TYPE.CURRENT_CHARACTER + '" ' + (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? 'selected' : '') + '>当前角色</option>'
            + '<option value="' + TARGET_TYPE.CURRENT_USER + '" ' + (b.targetType === TARGET_TYPE.CURRENT_USER ? 'selected' : '') + '>当前用户</option>'
            + '<option value="' + TARGET_TYPE.CUSTOM + '" ' + (b.targetType === TARGET_TYPE.CUSTOM ? 'selected' : '') + '>自定义</option>'
            + '</select>'
            + '<input class="text_pole mm-b-name" placeholder="角色名" value="' + escHtml(b.customName || '') + '" style="' + (b.targetType === TARGET_TYPE.CUSTOM ? '' : 'display:none') + '">'
            + '<input class="text_pole mm-b-aliases" placeholder="别名(逗号分隔)" value="' + escHtml(b.aliases || '') + '">'
            + '<select class="text_pole mm-b-voice-sel mm-voice-sel" style="flex:1"><option value="">直接输入</option></select>'
            + '<input class="text_pole mm-b-voice" placeholder="voiceId" value="' + escHtml(b.voiceId || '') + '">'
            + '<select class="text_pole mm-b-model" style="max-width:160px">' + MODEL_OPTIONS.map(function (o) { return '<option value="' + o.value + '"' + (b.model === o.value ? ' selected' : '') + '>' + o.label + '</option>'; }).join('') + '</select>'
            + '<button class="menu_button mm-b-del" style="padding:4px 10px;flex-shrink:0">×</button>';
        el.querySelector('.mm-b-type').addEventListener('change', function () {
            list[i].targetType = this.value;
            el.querySelector('.mm-b-name').style.display = this.value === TARGET_TYPE.CUSTOM ? '' : 'none';
            saveSettingsDebounced();
        });
        el.querySelector('.mm-b-name').addEventListener('input', function () { list[i].customName = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-b-aliases').addEventListener('input', function () { list[i].aliases = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-b-voice').addEventListener('input', function () { list[i].voiceId = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-b-voice-sel').addEventListener('change', function () {
            if (this.value) { el.querySelector('.mm-b-voice').value = this.value; list[i].voiceId = this.value; el.querySelector('.mm-b-voice').style.display = 'none'; }
            else { el.querySelector('.mm-b-voice').style.display = ''; }
            saveSettingsDebounced();
        });
        el.querySelector('.mm-b-model').addEventListener('change', function () { list[i].model = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-b-del').addEventListener('click', function () { list.splice(i, 1); renderBindings(); saveSettingsDebounced(); });
        c.appendChild(el);
    });
    refreshVoiceSelects();
}

function el(id) { return document.getElementById(id); }

function populateConfigFields() {
    var set = s();
    el('mm_key').value = set.apiKey || '';
    el('mm_gid').value = set.groupId || '';
    el('mm_apihost').value = set.apiHost || DEFAULT_API_HOST;
    el('mm_custom_host').value = set.customApiHost || '';
    var chr = document.getElementById('mm_custom_host_row');
    if (chr) chr.style.display = (set.apiHost === 'custom') ? '' : 'none';
    el('mm_model').value = set.model;
    el('mm_speed').value = set.speed;
    el('mm_vol').value = set.vol;
    el('mm_tts_lang').value = set.ttsLanguage || '';
    el('mm_autoplay').checked = set.autoPlay;
    el('mm_show_bubbles').checked = set.showBubbles || false;
    el('mm_show_fab').checked = set.showFloatingBtn !== false;
    el('mm_fab_img').value = set.floatingBtnImg || '';
    renderVoiceLibrary(); refreshVoiceSelects();
    var vs = el('mm_voice_sel'), vi = el('mm_voice');
    if (vs && vi) {
        if (set.voiceId) {
            for (var i = 0; i < vs.options.length; i++) {
                if (vs.options[i].value === set.voiceId) { vs.value = set.voiceId; vi.style.display = 'none'; break; }
            }
            if (vs.value !== set.voiceId) { vs.value = ''; vi.value = set.voiceId; vi.style.display = ''; }
        }}
    el('mm_f_en').checked = set.formatterEnabled || false;
    el('mm_f_prompt').value = set.formatterSystemPrompt || '';
    el('mm_def_male').value = set.defaultMaleVoiceId || '';
    el('mm_def_female').value = set.defaultFemaleVoiceId || '';
    el('mm_auto_clear').value = set.autoClearInterval || 0;
    renderBindings(); renderRules(); renderRegexPresets(); renderPreProcessRules();
    refreshAllLlmPresetSelects();
    var fSel = document.getElementById('mm_f_preset_sel');
    if (fSel && set.formatterPresetIdx >= 0) fSel.value = set.formatterPresetIdx;
    if (set.llmPresets.length && set.formatterPresetIdx >= 0) loadLlmPresetFieldsGlobal(set.formatterPresetIdx);
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
            + '<div class="mm-row"><label>悬浮按钮</label><input id="mm_show_fab" type="checkbox"></div>'
            + '<div class="mm-row"><label>按钮图片</label><input id="mm_fab_img" class="text_pole" placeholder="图片URL"></div>'
            + '<div class="mm-row"><button id="mm_test_tts" class="menu_button"><i class="fa-solid fa-play"></i> 测试语音</button></div>'
            + '<div class="mm-row"><button id="mm_clear_cache" class="menu_button" style="background:#ef5350"><i class="fa-solid fa-trash"></i> 清除所有语音缓存</button></div>'
            + '<div class="mm-section-title">语音库<button id="mm_add_voice" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+添加</button></div>'
            + '<p class="mm-desc">为语音ID起名。</p>'
            + '<div id="mm_voice_lib_rows"></div>'
            + '<div class="mm-section-title" style="margin-top:16px">角色绑定 <button id="mm_add_b" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+添加</button></div>'
            + '<p class="mm-desc">为角色分配专属音色。</p>'
            + '<div id="mm_b_rows"></div>'
            + '<div class="mm-section-title" style="margin-top:16px">默认NPC音色</div>'
            + '<p class="mm-desc">未匹配到绑定的角色，根据性别使用默认声音（需LLM返回gender字段）。</p>'
            + '<div class="mm-row"><label>默认男声</label><input id="mm_def_male" class="text_pole" placeholder="voiceId"></div>'
            + '<div class="mm-row"><label>默认女声</label><input id="mm_def_female" class="text_pole" placeholder="voiceId"></div>'
            + '<div class="mm-section-title" style="margin-top:16px">自动清理</div>'
            + '<div class="mm-row"><label>每N楼清理旧缓存</label><input id="mm_auto_clear" class="text_pole" type="number" min="0" step="1" style="max-width:80px"><span class="mm-inline-hint">0=关闭，4=每4楼清理之前的缓存</span></div>'
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
            + '<div class="mm-rule-header-row"><span></span><span>名称</span><span>正则</span><span style="flex:00 60px">Flags</span><span style="flex:0 0 68px">模式</span><span style="flex:0 0 30px"></span></div>'
            + '<div id="mm_rule_rows"></div>'
            + '<div class="mm-section-title" style="margin-top:12px">规则预设</div>'
            + '<div class="mm-row" style="flex-wrap:wrap;gap:6px"><select id="mm_regex_presets" class="text_pole" style="min-width:120px;flex:1"></select><button id="mm_regex_save_p" class="menu_button">保存</button><button id="mm_regex_upd_p" class="menu_button">更新</button><button id="mm_regex_del_p" class="menu_button">删除</button><button id="mm_regex_export" class="menu_button">导出</button><button id="mm_regex_import" class="menu_button">导入</button></div>'
            + '<div class="mm-section-title" style="margin-top:16px">副LLM格式化</div>'
            + '<div class="mm-row"><label>启用</label><input id="mm_f_en" type="checkbox"></div>'
            + '<div class="mm-row"><label>LLM预设</label><select id="mm_f_preset_sel" class="text_pole llm-preset-sel"></select></div>'
            + '<div class="mm-row" style="flex-wrap:wrap;gap:6px"><label style="min-width:85px">模板</label><select id="mm_f_templates" class="text_pole" style="min-width:120px;flex:1"></select><button id="mm_f_save_t" class="menu_button">保存</button><button id="mm_f_upd_t" class="menu_button">更新</button><button id="mm_f_del_t" class="menu_button">删除</button><button id="mm_f_export_t" class="menu_button">导出</button><button id="mm_f_import_t" class="menu_button">导入</button></div>'
            + '<div class="mm-row" style="align-items:flex-start"><label style="padding-top:6px">系统提示词</label><textarea id="mm_f_prompt" class="text_pole" style="flex:1;width:0"></textarea></div>'
            + '<div class="mm-section-title" style="margin-top:16px">预处理规则 '
            + '<button id="mm_add_pre_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+添加</button> '
            + '<button id="mm_pre_export" class="menu_button" style="font-size:0.8rem;padding:3px 10px">导出</button> '
            + '<button id="mm_pre_import" class="menu_button" style="font-size:0.8rem;padding:3px 10px">导入</button>'
            + '</div>'
            + '<p class="mm-desc">发给副LLM前的正则处理。</p>'
            + '<div class="mm-rule-header-row"><span></span><span>名称</span><span>正则</span><span style="flex:0 0 60px">Flags</span><span style="flex:0 0 68px">模式</span><span style="flex:0 0 30px"></span></div>'
            + '<div id="mm_pre_rule_rows"></div>'
            + '<div class="mm-section-title" style="margin-top:16px">调用日志 <button id="mm_clear_log" class="menu_button" style="font-size:0.8rem;padding:3px 10px">清除</button></div>'
            + '<div id="mm_log_box" style="background:rgba(0,0,0,.3);border-radius:8px;padding:8px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:0.78rem;color:#aaa"></div>'
            + '<div class="mm-row" style="margin-top:12px"><button id="mm_manual_gen" class="menu_button" style="flex:1"><i class="fa-solid fa-wand-magic-sparkles"></i> 手动分析最后一条消息</button></div>'
            + '</div>'

            + '</div></div></div>';

        document.body.insertAdjacentHTML('beforeend', panelHtml);

        renderTtsLogs();


        // Tab切换
        document.querySelectorAll('#mm-config-mask .mm-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var t = this.dataset.tab;
                document.querySelectorAll('#mm-config-mask .mm-tab').forEach(function (b) { b.classList.remove('active'); });
                this.classList.add('active');
                document.querySelectorAll('#mm-config-mask .mm-tab-panel').forEach(function (p) { p.classList.remove('active'); });
                document.querySelector('#mm-config-mask .mm-tab-panel[data-panel="' + t + '"]').classList.add('active');if (t === 'tts') { renderVoiceLibrary(); refreshVoiceSelects(); renderBindings(); }if (t === 'format') { renderRules(); renderRegexPresets(); renderPreProcessRules(); }});
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
            s().showFloatingBtn = document.getElementById('mm_show_fab').checked;
            s().floatingBtnImg = document.getElementById('mm_fab_img').value || '';
            if (window._mmFabUpdate) window._mmFabUpdate();
            s().defaultMaleVoiceId = document.getElementById('mm_def_male').value || '';
            s().defaultFemaleVoiceId = document.getElementById('mm_def_female').value || '';
            s().autoClearInterval = Number(document.getElementById('mm_auto_clear').value) || 0;
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

        var syncIds = ['mm_key', 'mm_gid', 'mm_apihost', 'mm_custom_host', 'mm_model', 'mm_voice_sel', 'mm_voice', 'mm_speed', 'mm_vol', 'mm_tts_lang', 'mm_autoplay', 'mm_def_male', 'mm_def_female', 'mm_auto_clear','mm_show_fab', 'mm_fab_img'];

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
                var testTexts = {
                    '': '你好，我是MiniMax语音。',
                    zh: '你好，我是MiniMax语音。',
                    en: 'Hello, I am MiniMax voice.',
                    ja: 'こんにちは',
                    ko: '안녕하세요',
                };

                var t = testTexts[s().ttsLanguage || ''] || testTexts[''];
                var b = await getAudioBlob({
                    text: t,
                    options: buildSynthesisOptions(null, null),
                    serverPath: null,
                });

                if (b && b._audioUrl) {
                    var a1 = new Audio(b._audioUrl);
                    await a1.play();
                } else {
                    var u1 = URL.createObjectURL(b);
                    var a2 = new Audio(u1);
                    a2.onended = function () { URL.revokeObjectURL(u1); };
                    a2.onerror = function () { URL.revokeObjectURL(u1); };
                    await a2.play();
                }

                toastr.success('连通成功！');
            } catch (e) {
                toastr.error('测试失败: ' + e.message);
            }
        });

        document.getElementById('mm_clear_cache').addEventListener('click', function () {
            s().serverHistory = {};
            localAudioCache.clear();
            saveSettingsDebounced();
            removeAllBubbles();
            refreshAllMessageButtons();
            toastr.success('缓存已全部清除');
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
            s().llmPreProcessRules.push({ id: 'p' + Date.now(), enabled: true, name: '新规则', pattern: '', flags: 'g', mode: 'exclude' });
            renderPreProcessRules(); saveSettingsDebounced();
        });
        document.getElementById('mm_pre_export').addEventListener('click', function () {
            var data = {
                type: 'minimax_quote_tts_preprocess_rules',
                version: 1,
                rules: s().llmPreProcessRules || [],
            };

            var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');

            a.href = url;
            a.download = 'minimax_preprocess_rules.json';
            a.click();

            setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 1000);

            toastr.success('预处理规则已导出');
        });

        document.getElementById('mm_pre_import').addEventListener('click', function () {
            var inp = document.createElement('input');

            inp.type = 'file';
            inp.accept = '.json,application/json';

            inp.onchange = async function () {
                if (!inp.files || !inp.files[0]) {
                    return;
                }

                try {
                    var text = await inp.files[0].text();
                    var data = JSON.parse(text);
                    var rules = [];

                    if (Array.isArray(data)) {
                        rules = data;
                    } else if (data && Array.isArray(data.rules)) {
                        rules = data.rules;
                    } else if (data && Array.isArray(data.llmPreProcessRules)) {
                        rules = data.llmPreProcessRules;
                    } else {
                        toastr.error('导入失败：文件里没有规则数组');
                        return;
                    }

                    rules = rules.map(function (r, idx) {
                        return {
                            id: r.id || ('p' + Date.now() + '_' + idx),
                            enabled: r.enabled !== false,
                            name: r.name || ('导入规则' + (idx + 1)),
                            pattern: r.pattern || '',
                            flags: r.flags || 'g',
                            mode: r.mode === 'extract' ? 'extract' : 'exclude',
                        };
                    }).filter(function (r) {
                        return r.pattern;
                    });

                    if (!rules.length) {
                        toastr.warning('没有可导入的有效规则');
                        return;
                    }

                    if (!s().llmPreProcessRules) {
                        s().llmPreProcessRules = [];
                    }

                    var replace = confirm('是否覆盖当前预处理规则？\n\n确定 = 覆盖\n取消 = 追加');

                    if (replace) {
                        s().llmPreProcessRules = rules;
                    } else {
                        s().llmPreProcessRules = s().llmPreProcessRules.concat(rules);
                    }

                    renderPreProcessRules();
                    saveSettingsDebounced();

                    toastr.success('已导入预处理规则：' + rules.length + '条');
                } catch (e) {
                    toastr.error('导入失败：' + e.message);
                }
            };

            inp.click();
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
            if (idx < 0|| !s().regexPresets || !s().regexPresets[idx]) return;
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
                document.getElementById('mm_llm_model_sel').style.display = 'none';}
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
                        body: { model: m, messages: [{ role: 'user', content:'Hi' }], max_tokens: 5},
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
        });upFT();

        document.getElementById('mm_clear_log').addEventListener('click', function () {
            ttsLogs = [];
            document.getElementById('mm_log_box').innerHTML = '';
        });

        document.getElementById('mm_manual_gen').addEventListener('click', async function () {
            var ctx = getContext();
            if (!ctx.chat || !ctx.chat.length) { toastr.warning('没有消息'); return; }
            var lastIdx = ctx.chat.length - 1;
            for (var gi = lastIdx; gi >= 0; gi--) {
                if (!ctx.chat[gi].is_user) { lastIdx = gi; break; }
            }
            ttsLog('手动触发分析 消息#' + lastIdx);
            toastr.info('分析中...');
            var ok = await generateMessageSpeech(lastIdx, true);
            if (ok) {
                injectBubbles(lastIdx);
                toastr.success('分析完成！');
            }
        });
    }

    populateConfigFields();

    document.getElementById('mm-config-mask').classList.add('mm-config-open');
}

//═══════════════════════════════
//  启动入口
// ═══════════════════════════════

function createUi() {
    if (window._mmtts_ui_created) return;
    window._mmtts_ui_created = true;
    injectStyles();
    if (!document.getElementById('mm_wand_item')) {
        $('#extensionsMenu').append(
            '<div id="mm_wand_item" class="list-group-item flex-container flexGap5" title="MiniMax TTS">'
            + '<div class="fa-solid fa-volume-high extensionsMenuExtensionButton"></div>MiniMax语音</div>'
        );
    }



    // 清理旧的绿色移动端悬浮按钮和旧快捷菜单
    var oldMobileBtn = document.getElementById('mm_mobile_float_btn');
    if (oldMobileBtn) {
        oldMobileBtn.remove();
    }

    var oldMobMenu = document.getElementById('mm_mob_menu');
    if (oldMobMenu) {
        oldMobMenu.remove();
    }

    var oldMobBackdrop = document.getElementById('mm_mob_backdrop');
    if (oldMobBackdrop) {
        oldMobBackdrop.remove();
    }



    $('#mm_wand_item').on('click', function () {
        var m = document.getElementById('extensionsMenu');
        if (m) m.style.display = 'none';
        openConfigPanel();
    });
    loadSettings();
    syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());
    refreshAllLlmPresetSelects();eventSource.on(event_types.CHARACTER_SELECTED, function () { if (document.getElementById('mm_b_rows')) renderBindings(); });
    eventSource.on(event_types.CHAT_CHANGED, function () { if (document.getElementById('mm_b_rows')) renderBindings(); });
    //悬浮按钮
    var fabHtml = '<div class="mm-fab-wrap" id="mm_fab_wrap" style="display:none">'
        + '<div class="mm-fab" id="mm_fab" title="打开语音操作菜单">'
        + '<i class="fa-solid fa-headphones"></i>'
        + '</div></div>';
    document.body.insertAdjacentHTML('beforeend', fabHtml);

    var mmFabWrap = document.getElementById('mm_fab_wrap');
    var mmFab = document.getElementById('mm_fab');

    if (mmFabWrap) {
        mmFabWrap.style.width = '52px';
        mmFabWrap.style.height = '52px';
        mmFabWrap.style.minWidth = '52px';
        mmFabWrap.style.minHeight = '52px';
        mmFabWrap.style.maxWidth = '52px';
        mmFabWrap.style.maxHeight = '52px';
    }

    if (mmFab) {
        mmFab.style.width = '52px';
        mmFab.style.height = '52px';
        mmFab.style.minWidth = '52px';
        mmFab.style.minHeight = '52px';
        mmFab.style.maxWidth = '52px';
        mmFab.style.maxHeight = '52px';
        mmFab.style.padding = '0';
        mmFab.style.margin = '0';
        mmFab.style.border = 'none';
        mmFab.style.outline = 'none';
        mmFab.style.boxShadow = 'none';
        mmFab.style.background = 'transparent';
        mmFab.style.backgroundColor = 'transparent';
        mmFab.style.fontSize = '30px';
        mmFab.style.lineHeight = '1';
        mmFab.style.display = 'flex';
        mmFab.style.alignItems = 'center';
        mmFab.style.justifyContent = 'center';
        mmFab.style.overflow = 'hidden';

        var mmFabIcon = mmFab.querySelector('i');
        if (mmFabIcon) {
            mmFabIcon.style.fontSize = '30px';
            mmFabIcon.style.width = 'auto';
            mmFabIcon.style.height = 'auto';
            mmFabIcon.style.lineHeight = '1';
            mmFabIcon.style.display = 'inline-flex';
            mmFabIcon.style.alignItems = 'center';
            mmFabIcon.style.justifyContent = 'center';
        }

        var mmFabImg = mmFab.querySelector('img');
        if (mmFabImg) {
            mmFabImg.style.width = '52px';
            mmFabImg.style.height = '52px';
            mmFabImg.style.minWidth = '52px';
            mmFabImg.style.minHeight = '52px';
            mmFabImg.style.maxWidth = '52px';
            mmFabImg.style.maxHeight = '52px';
            mmFabImg.style.objectFit = 'cover';
            mmFabImg.style.objectPosition = 'center center';
            mmFabImg.style.transform = 'scale(1.18)';
            mmFabImg.style.transformOrigin = 'center center';
            mmFabImg.style.display = 'block';
            mmFabImg.style.padding = '0';
            mmFabImg.style.margin = '0';
        }
    }



    if (mmFab) {
        mmFab.style.width = '72px';
        mmFab.style.height = '72px';
        mmFab.style.minWidth = '72px';
        mmFab.style.minHeight = '72px';
        mmFab.style.maxWidth = '72px';
        mmFab.style.maxHeight = '72px';
        mmFab.style.padding = '0';
        mmFab.style.margin = '0';
        mmFab.style.border = 'none';
        mmFab.style.outline = 'none';
        mmFab.style.boxShadow = 'none';
        mmFab.style.background = 'transparent';
        mmFab.style.backgroundColor = 'transparent';
        mmFab.style.fontSize = '42px';
        mmFab.style.lineHeight = '72px';
        mmFab.style.display = 'flex';
        mmFab.style.alignItems = 'center';
        mmFab.style.justifyContent = 'center';

        var mmFabIcon = mmFab.querySelector('i');
        if (mmFabIcon) {
            mmFabIcon.style.fontSize = '42px';
            mmFabIcon.style.width = '72px';
            mmFabIcon.style.height = '72px';
            mmFabIcon.style.lineHeight = '72px';
            mmFabIcon.style.display = 'flex';
            mmFabIcon.style.alignItems = 'center';
            mmFabIcon.style.justifyContent = 'center';
        }

        var mmFabImg = mmFab.querySelector('img');
        if (mmFabImg) {
            mmFabImg.style.width = '72px';
            mmFabImg.style.height = '72px';
            mmFabImg.style.minWidth = '72px';
            mmFabImg.style.minHeight = '72px';
            mmFabImg.style.maxWidth = '72px';
            mmFabImg.style.maxHeight = '72px';
            mmFabImg.style.objectFit = 'contain';
        }
    }

    var fabGenerating = false, fabAbort = null;
    var fabDragging = false, fabMoved = false;
    var fabStartX = 0, fabStartY = 0, fabOrigX = 0, fabOrigY = 0;

    function applyFabPosition() {
        var w = document.getElementById('mm_fab_wrap');
        if (!w) return;

        if (typeof s().floatingBtnX === 'number' && typeof s().floatingBtnY === 'number') {
            w.style.left = s().floatingBtnX + 'px';
            w.style.top = s().floatingBtnY + 'px';
            w.style.right = 'auto';
            w.style.bottom = 'auto';
        } else {
            w.style.left = 'auto';
            w.style.top = 'auto';
            w.style.right = '24px';
            w.style.bottom = '80px';
        }
    }

    function setFabIcon() {
        var fab = document.getElementById('mm_fab');
        if (!fab) return;
        if (fabGenerating) {
            fab.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        } else if (s().floatingBtnImg) {
            fab.innerHTML = '<img src="' + escHtml(s().floatingBtnImg) + '">';
        } else {
            fab.innerHTML = '<i class="fa-solid fa-headphones"></i>';
        }
    }

    function updateFabVisibility() {
        var w = document.getElementById('mm_fab_wrap');
        if (w) {
            w.style.display = s().showFloatingBtn ? '' : 'none';
            applyFabPosition();
        }setFabIcon();
    }

    updateFabVisibility();

    var fabWrap = document.getElementById('mm_fab_wrap');
    var fabBtn = document.getElementById('mm_fab');

    fabBtn.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;

        fabDragging = true;
        fabMoved = false;
        fabStartX = e.clientX;
        fabStartY = e.clientY;

        var rect = fabWrap.getBoundingClientRect();
        fabOrigX = rect.left;
        fabOrigY = rect.top;

        fabBtn.setPointerCapture && fabBtn.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    fabBtn.addEventListener('pointermove', function (e) {
        if (!fabDragging) return;

        var dx = e.clientX - fabStartX;
        var dy = e.clientY - fabStartY;

        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) fabMoved = true;

        var nx = fabOrigX + dx;
        var ny = fabOrigY + dy;

        var maxX = window.innerWidth - fabWrap.offsetWidth;
        var maxY = window.innerHeight - fabWrap.offsetHeight;

        nx = Math.max(0, Math.min(maxX, nx));
        ny = Math.max(0, Math.min(maxY, ny));

        fabWrap.style.left = nx + 'px';
        fabWrap.style.top = ny + 'px';
        fabWrap.style.right = 'auto';
        fabWrap.style.bottom = 'auto';

        // 拖动悬浮按钮时关闭已打开的操作菜单，避免菜单停在旧位置
        closeActionMenu();

        e.preventDefault();
    });

    fabBtn.addEventListener('pointerup', function (e) {
        if (!fabDragging) return;
        fabDragging = false;

        if (fabMoved) {
            var rect = fabWrap.getBoundingClientRect();
            s().floatingBtnX = Math.round(rect.left);
            s().floatingBtnY = Math.round(rect.top);
            saveSettingsDebounced();

            // 防止拖拽结束触发click
            setTimeout(function () { fabMoved = false; }, 120);
        }

        fabBtn.releasePointerCapture && fabBtn.releasePointerCapture(e.pointerId);
        e.preventDefault();
    });

    fabBtn.addEventListener('pointercancel', function () {
        fabDragging = false;
        setTimeout(function () { fabMoved = false; }, 120);
    });

    document.getElementById('mm_fab').addEventListener('click', function (e) {
        console.log('[MiniMax TTS] 点击了 mm_fab（消息操作菜单）');

        if (fabMoved) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        e.preventDefault();
        e.stopPropagation();

        if (fabGenerating) {
            fabGenerating = false;

            if (fabAbort) {
                fabAbort.cancelled = true;
            }

            var fab = this;

            fab.classList.remove('generating');

            if (s().floatingBtnImg) {
                fab.innerHTML = '<img src="' + escHtml(s().floatingBtnImg) + '">';
            } else {
                fab.innerHTML = '<i class="fa-solid fa-headphones"></i>';
            }

            toastr.warning('已取消生成');

            return false;
        }

        var ctx = getContext();

        if (!ctx.chat || !ctx.chat.length) {
            toastr.warning('没有消息');
            return false;
        }

        var lastIdx = -1;

        for (var gi = ctx.chat.length - 1; gi >= 0; gi--) {
            if (!ctx.chat[gi].is_user) {
                lastIdx = gi;
                break;
            }
        }

        if (lastIdx < 0) {
            toastr.warning('没有AI消息');
            return false;
        }

        showActionMenu(lastIdx, this);

        return false;
    });


    window._mmFabUpdate = updateFabVisibility;
}

jQuery(async function () {
    loadSettings();
    createUi();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async function (id) {
        // 自动清理旧缓存
        var clearN = s().autoClearInterval || 0;
        if (clearN > 0 && id > clearN) {
            var ctx2 = getContext();
            for (var ci = 0; ci < id - clearN; ci++) {
                var cm = ctx2.chat[ci];
                if (!cm) continue;
                var ck = buildMessageKey(ctx2, ci, cm);
                if (s().serverHistory[ck]) {
                    delete s().serverHistory[ck];
                }
            }
            saveSettingsDebounced();
        }

        // 只注入已有的气泡，不自动生成
        injectBubbles(id);
    });



    eventSource.on(event_types.CHAT_CHANGED, function () {
        setTimeout(refreshAllBubbles, 600);
    });

    // 单击喇叭按钮 →弹出操作菜单
    $(document).on('click', '.mes_quote_tts', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var mesid = Number($(this).closest('.mes').attr('mesid'));
        var existing = document.querySelector('.mm-action-menu');
        if (existing) {
            closeActionMenu();
            return;
        }
        showActionMenu(mesid, this);
    });


    // 定时刷新
    setInterval(function () {
        refreshAllMessageButtons();
       }, 3000);

    // 行内编辑模式：选中文字后添加气泡
    $(document).on('mouseup', '#chat .mes_text', function () {
        if (!mmInlineEditState) {
            return;
        }

        setTimeout(function () {
            addSelectedTextAsBubble();
        }, 30);
    });


    // 气泡点击播放 / 编辑模式点击删除
    $(document).on('click', '.mm-bubble', async function (e) {
        var $b = $(this);
        var mesid = Number($b.data('mesid'));
        var segidx = Number($b.data('segidx'));

        // 行内编辑模式下，点击气泡就是删除，不播放
        if (mmInlineEditState && Number(mmInlineEditState.mesid) === mesid) {
            e.preventDefault();
            e.stopPropagation();

            deleteBubbleInInlineEditor(mesid, segidx);

            return false;
        }

        if ($b.hasClass('mm-bubble-loading') || $b.hasClass('mm-bubble-playing')) {
            return;
        }

        var data = getMessageData(mesid);
        var h = s().serverHistory[data.key];

        if (!h || !h.versions || !h.versions[h.activeIndex]) {
            return;
        }

        var item = h.versions[h.activeIndex].items[segidx];

        if (!item) {
            return;
        }

        $b.addClass('mm-bubble-loading');

        try {
            var blob = await getAudioBlob(item);

            $b.removeClass('mm-bubble-loading').addClass('mm-bubble-playing');

            refreshBubbleStates(mesid);
            refreshAllMessageButtons();

            if (blob && blob._audioUrl) {
                var a1 = new Audio(blob._audioUrl);

                a1.onended = function () {
                    $b.removeClass('mm-bubble-playing');
                };

                a1.onerror = function () {
                    $b.removeClass('mm-bubble-playing');
                };

                await a1.play();
            } else {
                var u = URL.createObjectURL(blob);
                var a2 = new Audio(u);

                a2.onended = function () {
                    URL.revokeObjectURL(u);
                    $b.removeClass('mm-bubble-playing');
                };

                a2.onerror = function () {
                    URL.revokeObjectURL(u);
                    $b.removeClass('mm-bubble-playing');
                };

                await a2.play();
            }
        } catch (e) {
            $b.removeClass('mm-bubble-loading mm-bubble-playing');
            toastr.error('播放失败: ' + e.message);
        }
    });

});
