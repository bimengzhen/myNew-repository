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
    serverHistory: {}, favoriteAudios: [], voiceLibrary: [], regexRules: [], regexPresets: [],
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
let mmBubbleLongPressTimer = null;
let mmBubbleLongPressFired = false;


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
    var allowed = 'dgimsuy';
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
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', ...(opt.headers || {}) },
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
        var mm = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            pcm: 'audio/pcm',
            flac: 'audio/flac',
        };

        // 如果看起来像十六进制，按 hex 解码
        if (/^[0-9a-fA-F]+$/.test(a) && a.length % 2 === 0) {
            return new Blob([
                new Uint8Array(a.match(/.{1,2}/g).map(function (b) {
                    return parseInt(b, 16);
                })),
            ], {
                type: mm[fmt] || 'audio/mpeg',
            });
        }

        // 否则按 base64 解码
        try {
            var bc = atob(a);
            var ba = new Uint8Array(bc.length);

            for (var j = 0; j < bc.length; j++) {
                ba[j] = bc.charCodeAt(j);
            }

            return new Blob([ba], {
                type: mm[fmt] || 'audio/mpeg',
            });
        } catch (e) {
            throw new Error('音频数据既不是有效base64，也不是hex');
        }
    }
    var h = d.data?.audio_hex || d.audio_hex;

    if (h && typeof h === 'string') {
        var hm = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            pcm: 'audio/pcm',
            flac: 'audio/flac',
        };

        return new Blob([
            new Uint8Array(h.match(/.{1,2}/g).map(function (b) {
                return parseInt(b, 16);
            })),
        ], {
            type: hm[fmt] || 'audio/mpeg',
        });
    }
    throw new Error('API返回格式无法识别');
}



async function pollTaskResult(baseUrl, headers, taskId) {
    const MAX = 60, INT = 2000;
    const urls = [
        baseUrl + '/' + taskId,
        baseUrl + '?task_id=' + taskId,
    ];

    for (let i = 0; i < MAX; i++) {
        await new Promise(r => setTimeout(r, INT));

        for (const pu of (i === 0 ? urls : [urls[0]])) {
            try {
                let r = await fetch(pu, { method: 'GET', headers });

                if (r.status === 405 || r.status === 404) {
                    r = await fetch(baseUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ task_id: taskId }),
                    });
                }

                if (!r.ok) {
                    continue;
                }

                const ct = (r.headers.get('content-type') || '').toLowerCase();

                if (ct.includes('audio/') || ct.includes('octet-stream')) {
                    return await r.blob();
                }

                const d = await r.json();

                console.log('[MiniMax TTS] 轮询#' + (i + 1) + ':', JSON.stringify(d).slice(0, 300));

                const st = (d.status || d.data?.status || '').toLowerCase();

                if (st === 'error' || st === 'failed') {
                    throw new Error(d.message || d.error || '任务失败');
                }

                if (['completed', 'done', 'success', 'finished'].includes(st)) {
                    return await extractAudioFromResponse(d, 'mp3');
                }

                if (getAudioFieldFromResponse(d)) {
                    return await extractAudioFromResponse(d, 'mp3');
                }

                if (i === 0) {
                    urls.length = 0;
                    urls.push(pu);
                }

                break;
            } catch (e) {
                if (String(e && e.message || '').includes('任务失败')) {
                    throw e;
                }
            }
        }
    }

    throw new Error('任务超时');
}


async function directMinimaxTts(text, options) {
    const set = s(), apiKey = (set.apiKey || '').trim();

    if (!apiKey) {
        throw new Error('请先填写API Key');
    }

    let url;
    const apiHost = (set.apiHost || DEFAULT_API_HOST).replace(/\/+$/, '');

    if (apiHost !== 'custom' && !(set.groupId || '').trim()) {
        throw new Error('请先填写Group ID');
    }

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

    if (localAudioCache.has(ck)) {
        return localAudioCache.get(ck);
    }

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
            headers: {
                ...getRequestHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: item.text,

                // MiniMax 基础配置
                apiHost: s().apiHost,
                customApiHost: s().customApiHost || '',
                apiKey: s().apiKey || '',
                groupId: s().groupId || '',

                // 合成参数
                model: item.options.model,
                voiceId: item.options.voiceId,
                speed: item.options.speed,
                volume: item.options.vol,
                vol: item.options.vol,
                pitch: item.options.pitch,
                format: item.options.audioFormat,
                audioFormat: item.options.audioFormat,
                emotion: item.options.emotion,
                language: item.options.language || undefined,
            }),
        });

        if (r.status === 404 || r.status === 501 || r.status === 405) {
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

        const ct = (r.headers.get('content-type') || '').toLowerCase();

        if (ct.includes('application/json')) {
            const d = await r.json();
            blob = await extractAudioFromResponse(d, item.options.audioFormat || 'mp3');
        } else {
            blob = await r.blob();
        }
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
                                it.serverPath = p;
                            }
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

    function extractJsonObjectFromText(rawText) {
        var raw = String(rawText || '').trim();
        var codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);

        if (codeBlock && codeBlock[1]) {
            raw = codeBlock[1].trim();
        }

        var start = raw.indexOf('{');
        var end = raw.lastIndexOf('}');

        if (start < 0 || end <= start) {
            return '';
        }

        return raw.slice(start, end + 1);
    }

    var cleaned = extractJsonObjectFromText(text);
    ttsLog('清理后: ' + cleaned.slice(0, 300));

    if (!cleaned) {
        ttsLog('无法提取JSON: ' + text.slice(0, 200), 'error');
        throw new Error('AI返回无有效JSON');
    }

    try {
        var parsed = JSON.parse(cleaned);
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
        ttsLog('JSON解析失败: ' + e.message + ' 原文: ' + cleaned.slice(0, 200), 'error');
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
            if (!qm[0]) {
                re.lastIndex++;
                continue;
            }

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

            if (samePos || sameFull || (sameText && overlap)) {
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
    text = String(text || '');

    var extracted = [];

    function addMatches(pattern, type) {
        var re = new RegExp(pattern, 'gs');
        var m;

        while ((m = re.exec(text)) !== null) {
            // 防止零宽匹配导致死循环
            if (!m[0]) {
                re.lastIndex++;
                continue;
            }

            var full = (m[0] || '').trim();
            var inner = (m[1] || '').trim();

            if (!inner || inner.length < 1) {
                continue;
            }

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
    addMatches('["\\u201c\\u300c\\u300e\\u2018]([\\s\\S]{1,500}?)["\\u201d\\u300d\\u300f\\u2019]', 'quote');

    // 星号
    addMatches('\\*([\\s\\S]{1,500}?)\\*', 'action');

    // 按原文顺序排序
    extracted.sort(function (a, b) {
        return a.pos - b.pos;
    });

    // 重新编号
    for (var i = 0; i < extracted.length; i++) {
        extracted[i].idx = i;
    }

    return extracted;
}

async function generateMessageSpeech(id, forced) {
    if (!s().enabled) {
        return false;
    }

    var data = getMessageData(id);
    var message = data.message, key = data.key;

    if (!message || message.is_system || (s().onlyCharacter && message.is_user)) {
        return false;
    }

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
            raw = rules.length ? runRegexExtraction(ct, rules, message.name) : [];
        }

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

        var origText = message.mes || '';

        function normText(v) {
            return String(v || '')
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, '')
                .toLowerCase();
        }

        function findFuzzyInOrig(segText) {
            if (!segText) return '';

            // 1. 原文直接匹配
            if (origText.indexOf(segText) >= 0) return segText;

            // 2. 各种包裹符号匹配
            var wraps = [
                ['\u201c', '\u201d'],
                ['\u300c', '\u300d'],
                ['\u300e', '\u300f'],
                ['\u2018', '\u2019'],
                ['"', '"'],
                ["'", "'"],
                ['(', ')'],
                ['\uff08', '\uff09'],
                ['*', '*'],
            ];

            for (var wi = 0; wi < wraps.length; wi++) {
                var wrapped = wraps[wi][0] + segText + wraps[wi][1];

                if (origText.indexOf(wrapped) >= 0) {
                    return segText;
                }
            }

            // 3. 去掉首尾包裹符号再匹配
            var trimmed = String(segText || '')
                .replace(/^[“”「」『』‘’"'（）()*\s]+/, '')
                .replace(/[“”「」『』‘’"'（）()*\s]+$/, '');

            if (trimmed && origText.indexOf(trimmed) >= 0) {
                return trimmed;
            }

            // 4. 忽略空白的模糊匹配
            var nSeg = normText(trimmed || segText);

            if (!nSeg) {
                return '';
            }

            var rawNorm = normText(origText);

            if (rawNorm.indexOf(nSeg) >= 0) {
                return trimmed || segText;
            }

            // 5. 长句部分匹配，取前 12 个非空白字符试试
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

        console.log('[MiniMax TTS] 生成 ' + items.length + ' 个片段:', items.map(function (it) {
            return it.speaker + ':' + it.text.slice(0, 20);
        }));

        if (!s().serverHistory[key]) {
            s().serverHistory[key] = { activeIndex: 0, versions: [] };
        }

        var newVer = {
            items: items,
            timestamp: Date.now(),
        };

        if (s().formatterEnabled) {
            newVer._fromFormatter = true;
        }

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

        if (!data.message || data.message.is_system) {
            return;
        }

        if (s().onlyCharacter && data.message.is_user) {
            return;
        }

        var extra = el.querySelector('.extraMesButtons');

        if (!extra) {
            return;
        }

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

    if (isFavoriteAudioItem(item)) {
        el.classList.add('mm-bubble-favorite');
        el.title = '已收藏：' + (item.text || '');
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
    document.querySelectorAll('.mm-action-menu').forEach(function (m) {
        m.remove();
    });

    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('scroll', closeActionMenu, true);
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
        { icon: 'fa-solid fa-sliders', label: '可视面板', id: 'visual_panel', need: true },
        { icon: 'fa-solid fa-star', label: '我的收藏', id: 'favorites' },
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
    closeActionMenu();
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

        case 'visual_panel':
            openVisualVoicePanel(mesid);
            break;

        case 'favorites':
            openFavoriteAudioPanel();
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

function openVisualVoicePanel(id) {
    var data = getMessageData(id);
    var h = s().serverHistory[data.key];

    if (!h || !h.versions || !h.versions.length || !h.versions[h.activeIndex]) {
        toastr.warning('当前楼层还没有可编辑的语音片段，请先正则提取或API分析');
        return;
    }

    var version = h.versions[h.activeIndex];

    if (!version.items) {
        version.items = [];
    }

    var originalItems = cloneItems(version.items);
    var workingItems = cloneItems(version.items);
    var undoStack = [];
    var currentSpeaker = '__ALL__';

    function ensureOptions() {
        for (var i = 0; i < workingItems.length; i++) {
            var it = workingItems[i];

            if (!it) {
                continue;
            }

            if (!it.options) {
                it.options = buildSynthesisOptions(it, data.message);
            }

            if (it.options.speed == null) it.options.speed = s().speed || 1;
            if (it.options.vol == null) it.options.vol = s().vol != null ? s().vol : 1;
            if (it.options.pitch == null) it.options.pitch = s().pitch != null ? s().pitch : 0;
            if (!it.options.model) it.options.model = s().model;
            if (!it.options.voiceId) it.options.voiceId = s().voiceId;
            if (!it.options.audioFormat) it.options.audioFormat = s().audioFormat || 'mp3';
        }
    }

    function pushUndo() {
        undoStack.push(cloneItems(workingItems));

        if (undoStack.length > 50) {
            undoStack.shift();
        }
    }

    function getSpeakers() {
        var map = {};

        for (var i = 0; i < workingItems.length; i++) {
            var it = workingItems[i];

            if (!it || it.pauseMs) {
                continue;
            }

            var sp = String(it.speaker || '未分类').trim() || '未分类';
            map[sp] = true;
        }

        return Object.keys(map);
    }

    function modelOptionsHtml(value) {
        var html = '';

        for (var i = 0; i < MODEL_OPTIONS.length; i++) {
            var o = MODEL_OPTIONS[i];
            html += '<option value="' + escHtml(o.value) + '"' + (o.value === value ? ' selected' : '') + '>' + escHtml(o.label) + '</option>';
        }

        return html;
    }

    function emotionOptionsHtml(value, includeEmpty) {
        var emotions = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral'];
        var html = '';

        if (includeEmpty) {
            html += '<option value="">不修改</option>';
        } else {
            html += '<option value="">默认</option>';
        }

        for (var i = 0; i < emotions.length; i++) {
            var e = emotions[i];
            html += '<option value="' + escHtml(e) + '"' + (e === value ? ' selected' : '') + '>' + escHtml(e) + '</option>';
        }

        return html;
    }

    function getVisibleIndexes() {
        var arr = [];

        for (var i = 0; i < workingItems.length; i++) {
            var it = workingItems[i];

            if (!it || it.pauseMs) {
                continue;
            }

            var sp = String(it.speaker || '未分类').trim() || '未分类';

            if (currentSpeaker === '__ALL__' || currentSpeaker === sp) {
                arr.push(i);
            }
        }

        return arr;
    }

    function render() {
        ensureOptions();

        var speakers = getSpeakers();
        var visibleIndexes = getVisibleIndexes();

        var tabs = '<button class="mm-vp-tab' + (currentSpeaker === '__ALL__' ? ' active' : '') + '" data-speaker="__ALL__">全部</button>';

        for (var ti = 0; ti < speakers.length; ti++) {
            var sp = speakers[ti];
            tabs += '<button class="mm-vp-tab' + (currentSpeaker === sp ? ' active' : '') + '" data-speaker="' + escHtml(sp) + '">' + escHtml(sp) + '</button>';
        }

        var rows = '';

        for (var ri = 0; ri < visibleIndexes.length; ri++) {
            var idx = visibleIndexes[ri];
            var it = workingItems[idx];

            if (!it || it.pauseMs) {
                continue;
            }

            var opt = it.options || {};
            var speaker = String(it.speaker || '未分类').trim() || '未分类';
            var emotion = opt.emotion || '';

            rows += ''
                + '<div class="mm-vp-row" data-idx="' + idx + '">'
                + '  <div class="mm-vp-row-top">'
                + '    <label class="mm-vp-check-wrap"><input type="checkbox" class="mm-vp-check" data-idx="' + idx + '"> <span>#' + (idx + 1) + '</span></label>'
                + '    <div class="mm-vp-speaker">' + escHtml(speaker) + '</div>'
                + '    <button class="menu_button mm-vp-preview" data-idx="' + idx + '" title="试听这一句"><i class="fa-solid fa-comment-dots"></i> 试听</button>'
                + '  </div>'
                + '  <div class="mm-vp-text">' + escHtml(it.text || '') + '</div>'
                + '  <div class="mm-vp-grid">'
                + '    <div class="mm-vp-field"><label>情绪</label><select class="text_pole mm-vp-edit" data-idx="' + idx + '" data-prop="emotion">' + emotionOptionsHtml(emotion, false) + '</select></div>'
                + '    <div class="mm-vp-field"><label>语速</label><input class="text_pole mm-vp-edit" data-idx="' + idx + '" data-prop="speed" type="number" step="0.1" value="' + escHtml(opt.speed) + '"></div>'
                + '    <div class="mm-vp-field"><label>音量</label><input class="text_pole mm-vp-edit" data-idx="' + idx + '" data-prop="vol" type="number" step="0.1" value="' + escHtml(opt.vol) + '"></div>'
                + '    <div class="mm-vp-field"><label>音调</label><input class="text_pole mm-vp-edit" data-idx="' + idx + '" data-prop="pitch" type="number" step="1" min="-12" max="12" value="' + escHtml(opt.pitch) + '"></div>'
                + '    <div class="mm-vp-field"><label>模型</label><select class="text_pole mm-vp-edit" data-idx="' + idx + '" data-prop="model">' + modelOptionsHtml(opt.model) + '</select></div>'
                + '    <div class="mm-vp-field"><label>音色</label><input class="text_pole mm-vp-edit" data-idx="' + idx + '" data-prop="voiceId" value="' + escHtml(opt.voiceId || '') + '"></div>'
                + '  </div>'
                + '</div>';
        }

        if (!rows) {
            rows = '<div class="mm-vp-empty">这个分类下面没有可编辑句子。</div>';
        }

        var html = ''
            + '<div id="mm_visual_voice_panel" class="mm-config-mask mm-config-open">'
            + '  <div class="mm-config-dialog mm-vp-dialog">'
            + '    <div class="mm-config-header">'
            + '      <div style="font-weight:700;font-size:1rem;flex:1">可视语音面板 · 当前楼层</div>'
            + '      <button class="mm-config-close mm-vp-x">×</button>'
            + '    </div>'
            + '    <div class="mm-config-body mm-vp-body">'
            + '      <div class="mm-vp-tabs">' + tabs + '</div>'
            + '      <div class="mm-vp-bulk">'
            + '        <label class="mm-vp-select-all"><input type="checkbox" id="mm_vp_select_all"> 当前分类全选</label>'
            + '        <select class="text_pole" id="mm_vp_bulk_emotion">' + emotionOptionsHtml('', true) + '</select>'
            + '        <input class="text_pole" id="mm_vp_bulk_speed" type="number" step="0.1" placeholder="语速">'
            + '        <input class="text_pole" id="mm_vp_bulk_vol" type="number" step="0.1" placeholder="音量">'
            + '        <input class="text_pole" id="mm_vp_bulk_pitch" type="number" step="1" min="-12" max="12" placeholder="音调 -12 到 12">'
            + '        <input class="text_pole" id="mm_vp_bulk_voice" placeholder="音色 voiceId">'
            + '        <button class="menu_button" id="mm_vp_apply_bulk">应用到选中</button>'
            + '      </div>'
            + '      <div class="mm-vp-list">' + rows + '</div>'
            + '    </div>'
            + '    <div class="mm-vp-footer">'
            + '      <button class="menu_button" id="mm_vp_undo"><i class="fa-solid fa-rotate-left"></i> 撤回上一步</button>'
            + '      <div style="flex:1"></div>'
            + '      <button class="menu_button" id="mm_vp_cancel">取消</button>'
            + '      <button class="menu_button" id="mm_vp_confirm">确定</button>'
            + '    </div>'
            + '  </div>'
            + '</div>';

        $('#mm_visual_voice_panel').remove();
        $('body').append(html);

        bindEvents();
    }

    function bindEvents() {
        $('#mm_visual_voice_panel .mm-vp-tab').on('click', function () {
            currentSpeaker = String($(this).data('speaker'));
            render();
        });

        $('#mm_visual_voice_panel .mm-vp-x, #mm_vp_cancel').on('click', function () {
            version.items = cloneItems(originalItems);
            $('#mm_visual_voice_panel').remove();
            injectBubbles(id);
            refreshBubbleStates(id);
            refreshAllMessageButtons();
            toastr.warning('已取消修改');
        });

        $('#mm_vp_confirm').on('click', function () {
            version.items = cloneItems(workingItems);
            saveSettingsDebounced();
            $('#mm_visual_voice_panel').remove();
            injectBubbles(id);
            refreshBubbleStates(id);
            refreshAllMessageButtons();
            toastr.success('可视面板修改已保存');
        });

        $('#mm_vp_undo').on('click', function () {
            if (!undoStack.length) {
                toastr.warning('没有可撤回的操作');
                return;
            }

            workingItems = cloneItems(undoStack.pop());
            version.items = cloneItems(workingItems);
            render();
            toastr.success('已撤回上一步');
        });

        $('#mm_vp_select_all').on('change', function () {
            var checked = this.checked;
            $('#mm_visual_voice_panel .mm-vp-check').prop('checked', checked);
        });

        $('#mm_visual_voice_panel .mm-vp-edit').on('focus', function () {
            $(this).data('old-value', $(this).val());
        });

        $('#mm_visual_voice_panel .mm-vp-edit').on('change', function () {
            var idx = Number($(this).data('idx'));
            var prop = String($(this).data('prop'));
            var val = $(this).val();

            if (!workingItems[idx]) {
                return;
            }

            var selected = [];

            $('#mm_visual_voice_panel .mm-vp-check:checked').each(function () {
                selected.push(Number($(this).data('idx')));
            });

            // 如果当前正在编辑的这一句也在选中列表里，
            // 那么把这个值同步给所有选中的句子。
            // 如果没有选中当前句，就只改当前这一句。
            var applyIndexes = selected.indexOf(idx) >= 0 ? selected : [idx];

            pushUndo();

            if (prop === 'speed' || prop === 'vol' || prop === 'pitch') {
                val = Number(val);

                if (!Number.isFinite(val)) {
                    if (prop === 'speed') val = 1;
                    if (prop === 'vol') val = 1;
                    if (prop === 'pitch') val = 0;
                }

                if (prop === 'pitch') {
                    if (val > 12) val = 12;
                    if (val < -12) val = -12;
                }

                if (prop === 'speed') {
                    if (val > 2) val = 2;
                    if (val < 0.5) val = 0.5;
                }

                if (prop === 'vol') {
                    if (val > 10) val = 10;
                    if (val < 0.1) val = 0.1;
                }
            }

            for (var i = 0; i < applyIndexes.length; i++) {
                var targetIdx = applyIndexes[i];
                var it = workingItems[targetIdx];

                if (!it) {
                    continue;
                }

                if (!it.options) {
                    it.options = buildSynthesisOptions(it, data.message);
                }

                it.options[prop] = val;
                it.serverPath = null;
                delete it.apiLabeled;
            }

            version.items = cloneItems(workingItems);
            saveSettingsDebounced();

            if (applyIndexes.length > 1) {
                toastr.success('已同步到选中的 ' + applyIndexes.length + ' 句');
                render();
            }
        });

        $('#mm_vp_apply_bulk').on('click', function () {
            var selected = [];

            $('#mm_visual_voice_panel .mm-vp-check:checked').each(function () {
                selected.push(Number($(this).data('idx')));
            });

            if (!selected.length) {
                toastr.warning('请先选择要批量修改的句子');
                return;
            }

            var bulkEmotion = $('#mm_vp_bulk_emotion').val();
            var bulkSpeed = $('#mm_vp_bulk_speed').val();
            var bulkVol = $('#mm_vp_bulk_vol').val();
            var bulkPitch = $('#mm_vp_bulk_pitch').val();
            var bulkVoice = $('#mm_vp_bulk_voice').val();

            if (
                bulkEmotion === '' &&
                bulkSpeed === '' &&
                bulkVol === '' &&
                bulkPitch === '' &&
                bulkVoice === ''
            ) {
                toastr.warning('请至少填写一个批量参数');
                return;
            }

            pushUndo();

            for (var i = 0; i < selected.length; i++) {
                var idx = selected[i];
                var it = workingItems[idx];

                if (!it) {
                    continue;
                }

                if (!it.options) {
                    it.options = buildSynthesisOptions(it, data.message);
                }

                if (bulkEmotion !== '') it.options.emotion = bulkEmotion;

                if (bulkSpeed !== '') {
                    var nSpeed = Number(bulkSpeed);
                    if (!Number.isFinite(nSpeed)) nSpeed = 1;
                    if (nSpeed > 2) nSpeed = 2;
                    if (nSpeed < 0.5) nSpeed = 0.5;
                    it.options.speed = nSpeed;
                }

                if (bulkVol !== '') {
                    var nVol = Number(bulkVol);
                    if (!Number.isFinite(nVol)) nVol = 1;
                    if (nVol > 10) nVol = 10;
                    if (nVol < 0.1) nVol = 0.1;
                    it.options.vol = nVol;
                }

                if (bulkPitch !== '') {
                    var nPitch = Number(bulkPitch);
                    if (!Number.isFinite(nPitch)) nPitch = 0;
                    if (nPitch > 12) nPitch = 12;
                    if (nPitch < -12) nPitch = -12;
                    it.options.pitch = nPitch;
                }

                if (bulkVoice !== '') it.options.voiceId = bulkVoice;

                it.serverPath = null;
                delete it.apiLabeled;
            }

            version.items = cloneItems(workingItems);
            saveSettingsDebounced();
            render();
            toastr.success('已批量应用到选中句子');
        });

        $('#mm_visual_voice_panel .mm-vp-preview').on('click', async function () {
            var idx = Number($(this).data('idx'));
            var it = workingItems[idx];

            if (!it || !it.text) {
                toastr.warning('这一句没有文本');
                return;
            }

            try {
                $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中');

                if (!it.options) {
                    it.options = buildSynthesisOptions(it, data.message);
                }

                var result = await getAudioBlob(it);

                activeAudio.pause();
                activeAudio.src = '';

                if (result && result._audioUrl) {
                    activeAudio.src = result._audioUrl;
                    await activeAudio.play();
                } else {
                    var url = URL.createObjectURL(result);
                    activeAudio.src = url;
                    activeAudio.onended = function () {
                        URL.revokeObjectURL(url);
                    };
                    activeAudio.onerror = function () {
                        URL.revokeObjectURL(url);
                    };
                    await activeAudio.play();
                }

                version.items = cloneItems(workingItems);
                saveSettingsDebounced();
            } catch (err) {
                console.error('[MiniMax TTS] 试听失败', err);
                toastr.error('试听失败：' + (err.message || err));
            } finally {
                var btn = $('#mm_visual_voice_panel .mm-vp-preview[data-idx="' + idx + '"]');
                btn.prop('disabled', false).html('<i class="fa-solid fa-comment-dots"></i> 试听');
            }
        });
    }

    ensureOptions();
    render();
}

function getFavoriteAudioKey(item) {
    if (!item) {
        return '';
    }

    return 'fav_' + simpleHash(item.text || '') + '_' + simpleHash(JSON.stringify(item.options || {}));
}

function isFavoriteAudioItem(item) {
    var key = getFavoriteAudioKey(item);
    var list = s().favoriteAudios || [];

    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === key) {
            return true;
        }
    }

    return false;
}

async function favoriteBubbleAudio(mesid, segidx) {
    var data = getMessageData(mesid);
    var h = s().serverHistory[data.key];

    if (!h || !h.versions || !h.versions[h.activeIndex]) {
        toastr.warning('当前气泡没有可收藏的缓存数据');
        return;
    }

    var item = h.versions[h.activeIndex].items[segidx];

    if (!item || !item.text) {
        toastr.warning('这个气泡没有文本');
        return;
    }

    if (!s().favoriteAudios) {
        s().favoriteAudios = [];
    }

    var favKey = getFavoriteAudioKey(item);

    for (var i = 0; i < s().favoriteAudios.length; i++) {
        if (s().favoriteAudios[i] && s().favoriteAudios[i].key === favKey) {
            toastr.info('这个音频已经在收藏里了');
            return;
        }
    }

    toastr.info('正在收藏音频...');

    try {
        var blob = await getAudioBlob(item);
        var savedPath = item.serverPath || '';
        var savedUrl = '';

        if (blob instanceof Blob) {
            var fmt = item.options && item.options.audioFormat ? item.options.audioFormat : 'mp3';
            var up = await uploadToSTServer(blob, favKey + '.' + fmt);

            if (up) {
                savedPath = up;
            }
        } else if (blob && blob._audioUrl) {
            savedUrl = blob._audioUrl;

            // 如果可以跨域读取，就尝试再上传一份到本地文件，避免外链失效
            try {
                var rr = await fetch(blob._audioUrl);
                if (rr.ok) {
                    var remoteBlob = await rr.blob();
                    var fmt2 = item.options && item.options.audioFormat ? item.options.audioFormat : 'mp3';
                    var up2 = await uploadToSTServer(remoteBlob, favKey + '.' + fmt2);

                    if (up2) {
                        savedPath = up2;
                        savedUrl = '';
                    }
                }
            } catch (_) {}
        }

        if (!savedPath && !savedUrl) {
            toastr.error('收藏失败：没有拿到可保存的音频');
            return;
        }

        var fav = {
            key: favKey,
            text: item.text || '',
            speaker: item.speaker || '',
            emotion: item.options && item.options.emotion ? item.options.emotion : '',
            voiceId: item.options && item.options.voiceId ? item.options.voiceId : '',
            model: item.options && item.options.model ? item.options.model : '',
            options: JSON.parse(JSON.stringify(item.options || {})),
            serverPath: savedPath,
            audioUrl: savedUrl,
            createdAt: Date.now(),
        };

        s().favoriteAudios.unshift(fav);
        saveSettingsDebounced();

        injectBubbles(mesid);
        toastr.success('已收藏这个音频，清理缓存也不会丢');
    } catch (e) {
        console.error('[MiniMax TTS] 收藏失败', e);
        toastr.error('收藏失败：' + (e.message || e));
    }
}

function openFavoriteAudioPanel() {
    if (!s().favoriteAudios) {
        s().favoriteAudios = [];
    }

    var list = s().favoriteAudios || [];
    var rows = '';

    for (var i = 0; i < list.length; i++) {
        var fav = list[i];

        if (!fav) {
            continue;
        }

        var date = fav.createdAt ? new Date(fav.createdAt).toLocaleString() : '';

        rows += ''
            + '<div class="mm-fav-row" data-idx="' + i + '">'
            + '  <div class="mm-fav-top">'
            + '    <div class="mm-fav-title"><i class="fa-solid fa-star"></i> ' + escHtml(fav.speaker || '未分类') + '</div>'
            + '    <div class="mm-fav-date">' + escHtml(date) + '</div>'
            + '  </div>'
            + '  <div class="mm-fav-text">' + escHtml(fav.text || '') + '</div>'
            + '  <div class="mm-fav-meta">'
            + '    <span>情绪：' + escHtml(fav.emotion || '默认') + '</span>'
            + '    <span>音色：' + escHtml(fav.voiceId || '') + '</span>'
            + '    <span>模型：' + escHtml(fav.model || '') + '</span>'
            + '  </div>'
            + '  <div class="mm-fav-actions">'
            + '    <button class="menu_button mm-fav-play" data-idx="' + i + '"><i class="fa-solid fa-play"></i> 试听</button>'
            + '    <button class="menu_button mm-fav-copy" data-idx="' + i + '"><i class="fa-solid fa-copy"></i> 复制参数</button>'
            + '    <button class="menu_button mm-fav-del" data-idx="' + i + '" style="color:#ef5350"><i class="fa-solid fa-trash"></i> 删除</button>'
            + '  </div>'
            + '</div>';
    }

    if (!rows) {
        rows = '<div class="mm-fav-empty">还没有收藏音频。长按语音气泡可以收藏。</div>';
    }

    var html = ''
        + '<div id="mm_favorite_audio_panel" class="mm-config-mask mm-config-open">'
        + '  <div class="mm-config-dialog mm-fav-dialog">'
        + '    <div class="mm-config-header">'
        + '      <div style="font-weight:700;font-size:1rem;flex:1"><i class="fa-solid fa-star"></i> 我的收藏</div>'
        + '      <button class="mm-config-close mm-fav-close">×</button>'
        + '    </div>'
        + '    <div class="mm-config-body mm-fav-body">'
        + rows
        + '    </div>'
        + '  </div>'
        + '</div>';

    $('#mm_favorite_audio_panel').remove();
    $('body').append(html);

    $('#mm_favorite_audio_panel .mm-fav-close').on('click', function () {
        $('#mm_favorite_audio_panel').remove();
    });

    $('#mm_favorite_audio_panel .mm-fav-play').on('click', async function () {
        var idx = Number($(this).data('idx'));
        var fav = s().favoriteAudios[idx];

        if (!fav) {
            return;
        }

        try {
            activeAudio.pause();
            activeAudio.src = '';

            if (fav.serverPath) {
                activeAudio.src = fav.serverPath;
            } else if (fav.audioUrl) {
                activeAudio.src = fav.audioUrl;
            } else {
                toastr.warning('这个收藏没有可播放地址');
                return;
            }

            await activeAudio.play();
        } catch (e) {
            toastr.error('播放失败：' + (e.message || e));
        }
    });

    $('#mm_favorite_audio_panel .mm-fav-copy').on('click', function () {
        var idx = Number($(this).data('idx'));
        var fav = s().favoriteAudios[idx];

        if (!fav) {
            return;
        }

        var text = JSON.stringify({
            text: fav.text,
            speaker: fav.speaker,
            emotion: fav.emotion,
            voiceId: fav.voiceId,
            model: fav.model,
            options: fav.options,
        }, null, 2);

        navigator.clipboard.writeText(text).then(function () {
            toastr.success('已复制收藏参数');
        }).catch(function () {
            toastr.warning('复制失败');
        });
    });

    $('#mm_favorite_audio_panel .mm-fav-del').on('click', function () {
        var idx = Number($(this).data('idx'));

        if (!confirm('确定删除这个收藏吗？')) {
            return;
        }

        s().favoriteAudios.splice(idx, 1);
        saveSettingsDebounced();
        $('#mm_favorite_audio_panel').remove();
        openFavoriteAudioPanel();
        refreshAllBubbles();
        toastr.success('已删除收藏');
    });
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

            if (!it.options) {
                it.options = buildSynthesisOptions(it, data.message);
            }

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
    display:none!important;visibility:hidden!important;
    pointer-events:none!important;
}
#mm_mobile_float_btn:hover{
    display:none!important;
}

@media screen and (max-width: 700px) {
    #mm_mobile_float_btn {
        display: none !important;
    }

    .mm-config-mask.mm-config-open {
        display: flex !important;
        position: fixed !important;
        inset: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
        background: rgba(0, 0, 0, 0.55) !important;
        z-index: 2147483001 !important;align-items: center !important;
        justify-content: center !important;
        box-sizing: border-box !important;
    }

    .mm-config-mask.mm-config-open .mm-config-dialog {
        position: relative !important;
        left: auto !important;
        top: auto !important;
        right: auto !important;
        bottom: auto !important;
        transform: none !important;

        width: 94vw !important;
        max-width: 420px !important;

        height: auto !important;
        max-height: 80dvh !important;

        margin: 0 !important;
        padding: 0 !important;

        border-radius: 14px !important;
        overflow: hidden !important;

        display: flex !important;
        flex-direction: column !important;
    }

    .mm-config-mask.mm-config-open .mm-config-header {
        flex-shrink: 0 !important;
        padding: 7px 9px !important;
        gap: 4px !important;
    }

    .mm-config-mask.mm-config-open .mm-config-body {
        flex: 1 1 auto !important;
        overflow-y: auto !important;
        max-height: calc(80dvh - 46px) !important;
        padding: 10px !important;
        -webkit-overflow-scrolling: touch !important;
    }

    .mm-config-mask.mm-config-open .mm-tab-bar {
        display: flex !important;
        flex-wrap: nowrap !important;
        overflow-x: auto !important;
        gap: 2px !important;
        scrollbar-width: none !important;
    }

    .mm-config-mask.mm-config-open .mm-tab-bar::-webkit-scrollbar {
        display: none !important;
    }

    .mm-config-mask.mm-config-open .mm-tab {
        flex: 0 0 auto !important;
        padding: 5px 8px !important;
        font-size: 0.76rem !important;
        white-space: nowrap !important;
    }

    .mm-config-mask.mm-config-open .mm-config-close {
        font-size: 1rem !important;
        padding: 3px 6px !important;
    }

    .mm-config-mask.mm-config-open .mm-row {
        flex-wrap: wrap !important;
        align-items: flex-start !important;
        gap: 5px !important;
        margin-bottom: 8px !important;
    }

    .mm-config-mask.mm-config-open .mm-row > label {
        min-width: 64px !important;
        font-size: 0.78rem !important;
    }

    .mm-config-mask.mm-config-open .text_pole {
        height: 30px !important;
        font-size: 0.8rem !important;
    }

    .mm-config-mask.mm-config-open textarea.text_pole {
        min-height: 52px !important;
        max-height: 130px !important;
    }

    .mm-config-mask.mm-config-open .mm-section-title {
        font-size: 0.86rem !important;
        margin: 12px 0 6px !important;
        gap: 6px !important;
        flex-wrap: wrap !important;
    }

    .mm-config-mask.mm-config-open .mm-desc {
        font-size: 0.76rem !important;
        margin-bottom: 8px !important;
    }

    .mm-config-mask.mm-config-open #mm_log_box {
        max-height: 110px !important;
        font-size: 0.72rem !important;
    }

    .minimax-tts-editor-dialog {
        width: calc(100vw - 16px) !important;
        max-width: calc(100vw - 16px) !important;
        height: calc(100dvh - 32px) !important;
        max-height: calc(100dvh - 32px) !important;
    }

    .mm-rule-header-row {
        font-size: 0.72rem !important;
    }

    .mm-rule-row,
    .mm-binding-row,
    .mm-voice-lib-row {
        gap: 5px !important;
        flex-wrap: wrap !important;
    }

    .mm-rule-row .text_pole,
    .mm-binding-row .text_pole,
    .mm-voice-lib-row .text_pole {
        min-width: 120px !important;
        flex: 1 1 120px !important;
    }

    #mm_log_box {
        max-height: 120px !important;
        font-size: 0.72rem !important;
    }
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
    st.textContent += `
#mm_fab_wrap,
.mm-fab-wrap {
    position: fixed !important;
    z-index: 2147483000 !important;

    width: 52px !important;
    height: 52px !important;
    min-width: 52px !important;
    min-height: 52px !important;
    max-width: 52px !important;
    max-height: 52px !important;

    display: flex;
    align-items: center;
    justify-content: center;

    pointer-events: auto !important;
    touch-action: none !important;
    user-select: none !important;

    overflow: visible !important;
}

#mm_fab {
    pointer-events: auto !important;
    touch-action: none !important;
    user-select: none !important;
}

@media screen and (max-width: 700px) {
    #mm_fab_wrap,
    .mm-fab-wrap {
        z-index: 2147483000 !important;
    }
}
`;
st.textContent += `
#mm_visual_voice_panel {
    z-index: 2147483003 !important;
}

.mm-vp-dialog {
    width: min(980px, 96vw) !important;
    max-height: 92vh !important;
    background: var(--SmartThemeBlurTintColor, #1a1c2a) !important;
    color: var(--SmartThemeBodyColor, #ccc) !important;
}

.mm-vp-body {
    padding: 12px !important;
}

.mm-vp-tabs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 10px;
    border-bottom: 1px solid rgba(255,255,255,.08);
    padding-bottom: 8px;
}

.mm-vp-tab {
    border: none;
    border-radius: 999px;
    padding: 6px 12px;
    background: rgba(255,255,255,.08);
    color: inherit;
    cursor: pointer;
    opacity: .72;
    font-size: .86rem;
}

.mm-vp-tab:hover {
    opacity: 1;
    background: rgba(255,255,255,.14);
}

.mm-vp-tab.active {
    opacity: 1;
    background: rgba(255,255,255,.2);
    font-weight: 700;
}

.mm-vp-bulk {
    display: grid;
    grid-template-columns: 130px repeat(5, minmax(80px, 1fr)) 110px;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
    padding: 10px;
    border-radius: 12px;
    background: rgba(0,0,0,.16);
}

.mm-vp-select-all {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: .84rem;
    opacity: .9;
    white-space: nowrap;
}

.mm-vp-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.mm-vp-row {
    border-radius: 14px;
    background: rgba(255,255,255,.055);
    padding: 10px;
    border: 1px solid rgba(255,255,255,.07);
}

.mm-vp-row-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.mm-vp-check-wrap {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: .82rem;
    opacity: .85;
}

.mm-vp-speaker {
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(255,255,255,.1);
    font-size: .78rem;
    opacity: .9;
}

.mm-vp-preview {
    margin-left: auto;
    min-width: 76px;
    height: 30px !important;
    font-size: .8rem !important;
}

.mm-vp-text {
    font-size: .88rem;
    line-height: 1.45;
    opacity: .92;
    padding: 8px;
    margin-bottom: 10px;
    border-radius: 10px;
    background: rgba(0,0,0,.18);
    white-space: pre-wrap;
    word-break: break-word;
}

.mm-vp-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(80px, 1fr));
    gap: 8px;
}

.mm-vp-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.mm-vp-field label {
    font-size: .75rem;
    opacity: .65;
}

.mm-vp-field .text_pole {
    width: 100%;
    height: 30px !important;
    font-size: .8rem !important;
    box-sizing: border-box;
}

.mm-vp-footer {
    display: flex;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid rgba(255,255,255,.08);
    background: rgba(0,0,0,.12);
}

.mm-vp-empty {
    opacity: .65;
    text-align: center;
    padding: 30px 10px;
}

@media screen and (max-width: 700px) {
    .mm-vp-dialog {
        width: 94vw !important;
        max-width: 94vw !important;
        height: 86dvh !important;
        max-height: 86dvh !important;
    }

    .mm-vp-bulk {
        grid-template-columns: 1fr 1fr;
    }

    .mm-vp-grid {
        grid-template-columns: 1fr 1fr;
    }

    .mm-vp-preview {
        min-width: 64px;
        padding-left: 8px !important;
        padding-right: 8px !important;
    }
}
`;
    st.textContent += `
.mm-bubble.mm-bubble-favorite {
    background: rgba(255, 215, 90, 0.95) !important;
    border-color: rgba(255, 188, 40, 1) !important;
    color: #5a3b00 !important;
    box-shadow: 0 0 0 1px rgba(255, 215, 90, .35), 0 2px 8px rgba(0,0,0,.18) !important;
}

.mm-bubble.mm-bubble-favorite i {
    color: #7a4d00 !important;
}

.mm-bubble.mm-bubble-fav-saving {
    opacity: .7 !important;
    transform: scale(.96) !important;
}

.mm-fav-dialog {
    width: min(760px, 96vw) !important;
    max-height: 90vh !important;
}

.mm-fav-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.mm-fav-row {
    border-radius: 14px;
    padding: 10px;
    background: rgba(255,255,255,.055);
    border: 1px solid rgba(255,255,255,.08);
}

.mm-fav-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.mm-fav-title {
    font-weight: 700;
    flex: 1;
}

.mm-fav-title i {
    color: #ffd45a;
}

.mm-fav-date {
    font-size: .75rem;
    opacity: .55;
}

.mm-fav-text {
    padding: 8px;
    border-radius: 10px;
    background: rgba(0,0,0,.18);
    white-space: pre-wrap;
    word-break: break-word;
    font-size: .88rem;
    line-height: 1.45;
    margin-bottom: 8px;
}

.mm-fav-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
}

.mm-fav-meta span {
    font-size: .75rem;
    opacity: .75;
    padding: 3px 7px;
    border-radius: 999px;
    background: rgba(255,255,255,.08);
}

.mm-fav-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.mm-fav-empty {
    text-align: center;
    opacity: .65;
    padding: 40px 10px;
}
`;


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

    if (!s().characterBindingsMap) {
        s().characterBindingsMap = {};
    }

    if (!Array.isArray(s().characterBindingsMap[cid])) {
        s().characterBindingsMap[cid] = [];
    }

    var list = s().characterBindingsMap[cid];

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

    if (!el('mm_key')) {
        return;
    }

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

function applyMobileConfigPanelLayout() {
    var mask = document.getElementById('mm-config-mask');
    var dialog = mask ? mask.querySelector('.mm-config-dialog') : null;
    var body = dialog ? dialog.querySelector('.mm-config-body') : null;
    var header = dialog ? dialog.querySelector('.mm-config-header') : null;
    var tabBar = dialog ? dialog.querySelector('.mm-tab-bar') : null;

    if (!mask || !dialog) {
        return;
    }

    // 只在面板打开时强制修复，避免影响关闭状态
    if (!mask.classList.contains('mm-config-open')) {
        return;
    }

    // 手机端/窄屏/触屏都强制走移动端面板布局
    var isMobileLike = window.innerWidth <= 900 || window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

    if (!isMobileLike) {
        return;
    }

    // ===== 强制显示遮罩，绕过所有 CSS 冲突 =====
    mask.style.setProperty('display', 'flex', 'important');
    mask.style.setProperty('visibility', 'visible', 'important');
    mask.style.setProperty('opacity', '1', 'important');
    mask.style.setProperty('pointer-events', 'auto', 'important');

    mask.style.setProperty('position', 'fixed', 'important');
    mask.style.setProperty('left', '0', 'important');
    mask.style.setProperty('top', '0', 'important');
    mask.style.setProperty('right', '0', 'important');
    mask.style.setProperty('bottom', '0', 'important');
    mask.style.setProperty('inset', '0', 'important');

    mask.style.setProperty('width', '100vw', 'important');
    mask.style.setProperty('height', '100vh', 'important');
    mask.style.setProperty('height', '100dvh', 'important');

    mask.style.setProperty('padding', '10px', 'important');
    mask.style.setProperty('margin', '0', 'important');
    mask.style.setProperty('box-sizing', 'border-box', 'important');
    mask.style.setProperty('overflow', 'hidden', 'important');

    mask.style.setProperty('align-items', 'center', 'important');
    mask.style.setProperty('justify-content', 'center', 'important');

    mask.style.setProperty('background', 'rgba(0, 0, 0, 0.55)', 'important');
    mask.style.setProperty('z-index', '2147483647', 'important');

    // ===== 强制显示面板本体，避免跑到屏幕外 =====
    dialog.style.setProperty('display', 'flex', 'important');
    dialog.style.setProperty('visibility', 'visible', 'important');
    dialog.style.setProperty('opacity', '1', 'important');
    dialog.style.setProperty('pointer-events', 'auto', 'important');

    dialog.style.setProperty('position', 'relative', 'important');
    dialog.style.setProperty('left', 'auto', 'important');
    dialog.style.setProperty('top', 'auto', 'important');
    dialog.style.setProperty('right', 'auto', 'important');
    dialog.style.setProperty('bottom', 'auto', 'important');
    dialog.style.setProperty('transform', 'none', 'important');

    dialog.style.setProperty('width', '94vw', 'important');
    dialog.style.setProperty('max-width', '430px', 'important');
    dialog.style.setProperty('min-width', '0', 'important');

    dialog.style.setProperty('height', '82dvh', 'important');
    dialog.style.setProperty('max-height', '82dvh', 'important');
    dialog.style.setProperty('min-height', '0', 'important');

    dialog.style.setProperty('margin', '0', 'important');
    dialog.style.setProperty('padding', '0', 'important');
    dialog.style.setProperty('box-sizing', 'border-box', 'important');

    dialog.style.setProperty('border-radius', '14px', 'important');
    dialog.style.setProperty('overflow', 'hidden', 'important');
    dialog.style.setProperty('flex-direction', 'column', 'important');

    dialog.style.setProperty('background', 'var(--SmartThemeBlurTintColor, #1a1c2a)', 'important');
    dialog.style.setProperty('color', 'var(--SmartThemeBodyColor, #ccc)', 'important');
    dialog.style.setProperty('box-shadow', '0 12px 48px rgba(0,0,0,.55)', 'important');
    dialog.style.setProperty('z-index', '2147483647', 'important');

    if (header) {
        header.style.setProperty('display', 'flex', 'important');
        header.style.setProperty('align-items', 'center', 'important');
        header.style.setProperty('flex-shrink', '0', 'important');
        header.style.setProperty('padding', '7px 9px', 'important');
        header.style.setProperty('gap', '4px', 'important');
    }

    if (body) {
        body.style.setProperty('display', 'block', 'important');
        body.style.setProperty('flex', '1 1 auto', 'important');
        body.style.setProperty('height', 'calc(82dvh - 46px)', 'important');
        body.style.setProperty('max-height', 'calc(82dvh - 46px)', 'important');
        body.style.setProperty('min-height', '0', 'important');
        body.style.setProperty('overflow-y', 'auto', 'important');
        body.style.setProperty('padding', '10px', 'important');
        body.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
    }

    if (tabBar) {
        tabBar.style.setProperty('display', 'flex', 'important');
        tabBar.style.setProperty('flex-wrap', 'nowrap', 'important');
        tabBar.style.setProperty('overflow-x', 'auto', 'important');
        tabBar.style.setProperty('gap', '2px', 'important');
    }

    dialog.querySelectorAll('.mm-tab').forEach(function (tab) {
        tab.style.setProperty('flex', '0 0 auto', 'important');
        tab.style.setProperty('padding', '5px 8px', 'important');
        tab.style.setProperty('font-size', '0.76rem', 'important');
        tab.style.setProperty('white-space', 'nowrap', 'important');
    });

    dialog.querySelectorAll('.mm-row').forEach(function (row) {
        row.style.setProperty('flex-wrap', 'wrap', 'important');
        row.style.setProperty('align-items', 'flex-start', 'important');
        row.style.setProperty('gap', '5px', 'important');
        row.style.setProperty('margin-bottom', '8px', 'important');
    });

    dialog.querySelectorAll('.mm-row > label').forEach(function (label) {
        label.style.setProperty('min-width', '64px', 'important');
        label.style.setProperty('font-size', '0.78rem', 'important');
    });

    dialog.querySelectorAll('.text_pole').forEach(function (input) {
        input.style.setProperty('font-size', '0.8rem', 'important');
        input.style.setProperty('max-width', '100%', 'important');
        input.style.setProperty('box-sizing', 'border-box', 'important');
    });
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
            if (e.target === this) {
                this.classList.remove('mm-config-open');
                this.removeAttribute('style');

                var dialog = this.querySelector('.mm-config-dialog');

                if (dialog) {
                    dialog.removeAttribute('style');
                }
            }
        });

        document.querySelector('#mm-config-mask .mm-config-close').addEventListener('click', function () {
            var mask = document.getElementById('mm-config-mask');

            if (mask) {
                mask.classList.remove('mm-config-open');
                mask.removeAttribute('style');

                var dialog = mask.querySelector('.mm-config-dialog');

                if (dialog) {
                    dialog.removeAttribute('style');
                }
            }
        });


        // TTS同步
        var syncSecretsTimer = null;
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

            clearTimeout(syncSecretsTimer);
            syncSecretsTimer = setTimeout(function () {
                syncToSTSecrets((s().apiKey || '').trim(), (s().groupId || '').trim());
            }, 800);
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
            var btn = this;
            var oldText = btn.textContent;

            try {
                btn.disabled = true;
                btn.textContent = '测试中...';

                var testTexts = {
                    '': '你好，我是MiniMax语音。',
                    zh: '你好，我是MiniMax语音。',
                    en: 'Hello, I am MiniMax voice.',
                    ja: 'こんにちは',
                    ko: '안녕하세요',
                };

                var t = testTexts[s().ttsLanguage || ''] || testTexts[''];

                ttsLog('测试语音开始: ' + t);

                var item = {
                    text: t,
                    options: buildSynthesisOptions(null, null),
                    serverPath: null,
                };

                var b = await getAudioBlob(item);

                activeAudio.pause();
                activeAudio.src = '';

                if (b && b._audioUrl) {
                    activeAudio.src = b._audioUrl;
                    ttsLog('测试音频URL: ' + b._audioUrl.slice(0, 120));
                } else if (b instanceof Blob) {
                    var u1 = URL.createObjectURL(b);
                    activeAudio.src = u1;

                    activeAudio.onended = function () {
                        URL.revokeObjectURL(u1);
                    };

                    activeAudio.onerror = function () {
                        URL.revokeObjectURL(u1);
                    };

                    ttsLog('测试音频Blob大小: ' + b.size + ' bytes');
                } else {
                    throw new Error('没有拿到有效音频');
                }

                try {
                    await activeAudio.play();
                } catch (playErr) {
                    console.warn('[MiniMax TTS] 浏览器阻止播放:', playErr);

                    if (playErr && (playErr.name === 'NotAllowedError' || /gesture|user/i.test(playErr.message || ''))) {
                        toastr.warning('音频已生成，但浏览器阻止自动播放，请再点一次测试或手动播放');
                        throw new Error('浏览器阻止自动播放');
                    }

                    throw playErr;
                }

                toastr.success('连通成功！');
                ttsLog('测试语音成功', 'success');
            } catch (e) {
                console.error('[MiniMax TTS] 测试失败:', e);
                ttsLog('测试失败: ' + (e.message || e), 'error');

                var msg = e.message || String(e);

                if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
                    msg = '请求失败，通常是代理接口不可用或浏览器CORS拦截。请确认 /api/minimax/generate-voice 是否存在，或使用可跨域的中转站。';
                }

                toastr.error('测试失败: ' + msg);
            } finally {
                btn.disabled = false;
                btn.textContent = oldText;
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
                if (!inp.files || !inp.files[0]) {
                    return;
                }

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
                if (!inp.files || !inp.files[0]) {
                    return;
                }

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

    var mask = document.getElementById('mm-config-mask');

    if (mask) {
        mask.classList.add('mm-config-open');

        // 先立刻强制可见，避免手机端 CSS/旧内联样式导致第一帧不显示
        mask.style.setProperty('display', 'flex', 'important');
        mask.style.setProperty('visibility', 'visible', 'important');
        mask.style.setProperty('opacity', '1', 'important');
        mask.style.setProperty('pointer-events', 'auto', 'important');
        mask.style.setProperty('position', 'fixed', 'important');
        mask.style.setProperty('inset', '0', 'important');
        mask.style.setProperty('z-index', '2147483647', 'important');
    }

    applyMobileConfigPanelLayout();

    requestAnimationFrame(function () {
        applyMobileConfigPanelLayout();
    });

    setTimeout(function () {
        applyMobileConfigPanelLayout();
    }, 60);

    setTimeout(function () {
        applyMobileConfigPanelLayout();
    }, 200);

    setTimeout(function () {
        applyMobileConfigPanelLayout();
    }, 500);

    var mask = document.getElementById('mm-config-mask');

    if (mask) {
        mask.classList.add('mm-config-open');
        populateConfigFields();
        applyMobileConfigPanelLayout();
        setTimeout(applyMobileConfigPanelLayout, 50);
        setTimeout(applyMobileConfigPanelLayout, 250);
    }
    
}



//═══════════════════════════════
//  启动入口
// ═══════════════════════════════

function createUi() {
    if (window._mmtts_ui_created) return;
    injectStyles();
    loadSettings();

    var extMenu = document.getElementById('extensionsMenu');

    if (!extMenu) {
        console.warn('[MiniMax TTS] #extensionsMenu 未找到，稍后重试创建入口');
        setTimeout(createUi, 1000);
        return;
    }

    window._mmtts_ui_created = true;

    if (!document.getElementById('mm_wand_item')) {
        extMenu.insertAdjacentHTML(
            'beforeend',
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



    $('#mm_wand_item').off('click.mmtts').on('click.mmtts', function () {
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
    if (!document.body) {
        console.warn('[MiniMax TTS] document.body 未准备好，稍后重试创建UI');
        window._mmtts_ui_created = false;
        setTimeout(createUi, 1000);
        return;
    }

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
    window.addEventListener('resize', function () {
        applyFabPosition();
    });

    window.addEventListener('orientationchange', function () {
        setTimeout(applyFabPosition, 300);
    });


    var fabWrap = document.getElementById('mm_fab_wrap');
    var fabBtn = document.getElementById('mm_fab');

    if (!fabWrap || !fabBtn) {
        console.error('[MiniMax TTS] 悬浮按钮创建失败');
        return;
    }

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

    // 长按气泡收藏音频
    $(document).on('mousedown touchstart', '.mm-bubble', function (e) {
        var $b = $(this);
        var mesid = Number($b.data('mesid'));
        var segidx = Number($b.data('segidx'));

        if (mmInlineEditState && Number(mmInlineEditState.mesid) === mesid) {
            return;
        }

        clearTimeout(mmBubbleLongPressTimer);
        mmBubbleLongPressFired = false;

        mmBubbleLongPressTimer = setTimeout(async function () {
            mmBubbleLongPressFired = true;
            $b.addClass('mm-bubble-fav-saving');

            try {
                await favoriteBubbleAudio(mesid, segidx);
            } finally {
                $b.removeClass('mm-bubble-fav-saving');
            }
        }, 700);
    });

    $(document).on('mouseup mouseleave touchend touchcancel', '.mm-bubble', function () {
        clearTimeout(mmBubbleLongPressTimer);
    });


    // 气泡点击播放 / 编辑模式点击删除
    $(document).on('click', '.mm-bubble', async function (e) {
        if (mmBubbleLongPressFired) {
            e.preventDefault();
            e.stopPropagation();

            setTimeout(function () {
                mmBubbleLongPressFired = false;
            }, 50);

            return false;
        }

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
