// ============================================================
// 酒馆（SillyTavern）角色卡：JSON（V1 / V2 / V3），或者把 JSON 藏在 PNG 里的那种
// （PNG 的 tEXt 块，关键字 chara = V2、ccv3 = V3，内容是 base64 的 JSON）。
// 读出来：名字、拼好的 System prompt、开场白、自带的世界书。
// {{char}} 导入时换成角色名；{{user}} 留着，叫醒时换成绫戴着的面具的名字（没有面具就是她自己的名字）。
// ============================================================
const crypto = require('crypto');

const MAX = 20000; // System prompt 的上限，和 cats.js 一样

// tEXt / iTXt chunks of a PNG, as { keyword: text }.
function pngTexts(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) return null;
  const out = {};
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) out[data.toString('latin1', 0, z)] = data.toString('latin1', z + 1);
    } else if (type === 'iTXt') {
      // keyword \0 compression-flag compression-method language \0 translated \0 text (only uncompressed)
      const z = data.indexOf(0);
      if (z > 0 && data[z + 1] === 0) {
        const l1 = data.indexOf(0, z + 3), l2 = l1 >= 0 ? data.indexOf(0, l1 + 1) : -1;
        if (l2 >= 0) out[data.toString('latin1', 0, z)] = data.toString('utf8', l2 + 1);
      }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

function fromBase64Json(s) {
  try { return JSON.parse(Buffer.from(String(s).trim(), 'base64').toString('utf8')); } catch { return null; }
}

// The card's fields, whichever version it is.
function fieldsOf(json) {
  if (!json || typeof json !== 'object') return null;
  const d = json.data && typeof json.data === 'object' ? json.data : json;
  const str = v => (typeof v === 'string' ? v : '').replace(/\r\n/g, '\n').trim();
  const name = str(d.name || json.name || d.char_name);
  if (!name && !str(d.description) && !str(d.personality)) return null;
  return {
    name,
    description: str(d.description), personality: str(d.personality), scenario: str(d.scenario),
    firstMes: str(d.first_mes), examples: str(d.mes_example), systemPrompt: str(d.system_prompt),
    postHistory: str(d.post_history_instructions), book: d.character_book && typeof d.character_book === 'object' ? d.character_book : null,
  };
}

// Is this (parsed JSON) a character card rather than a world book?
const isCard = json => !!json && typeof json === 'object' && (/^chara_card/.test(json.spec || '') || (json.data && (json.data.first_mes !== undefined || json.data.description !== undefined))
  || (json.first_mes !== undefined && json.name !== undefined));

// Reads a .json or .png card. Throws a plain Chinese message when it is not one.
function read(buf, fileName = '') {
  if (!buf || !buf.length) throw new Error('没有收到文件');
  let json = null;
  const texts = pngTexts(buf);
  if (texts) {
    json = fromBase64Json(texts.ccv3 || '') || fromBase64Json(texts.chara || '');
    if (!json) throw new Error('这张图片里没有角色卡（酒馆的角色卡 PNG 里藏着一段资料，这张没有）');
  } else {
    try { json = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('读不懂这个文件：角色卡要是酒馆导出的 .json 或 .png'); }
  }
  const f = isCard(json) && fieldsOf(json);
  if (!f) throw new Error('这不像角色卡（如果是世界书，请到「世界书」里上传）');
  const name = f.name || String(fileName).replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '').slice(0, 16) || '新的猫';
  const charName = s => s.replace(/\{\{char\}\}|<BOT>/gi, name);
  const parts = [];
  if (f.systemPrompt) parts.push(f.systemPrompt.replace(/\{\{original\}\}/gi, '').trim());
  if (f.description) parts.push(`【${name}】\n${f.description}`);
  if (f.personality) parts.push(`【性格】\n${f.personality}`);
  if (f.scenario) parts.push(`【场景】\n${f.scenario}`);
  if (f.examples) parts.push(`【对话示例】\n${f.examples.replace(/<START>/gi, '——').trim()}`);
  if (f.postHistory) parts.push(f.postHistory.replace(/\{\{original\}\}/gi, '').trim());
  let systemPrompt = charName(parts.filter(Boolean).join('\n\n'));
  const cut = systemPrompt.length > MAX;
  if (cut) systemPrompt = systemPrompt.slice(0, MAX);
  return { name: name.slice(0, 16), fullName: name, systemPrompt, cut, firstMes: charName(f.firstMes), book: f.book, isPng: !!texts };
}

// Parsed cards wait here between 「读角色卡」 and 「搬进来」 (the world book can be big, so it is not sent back and forth).
const pending = new Map();
function keep(ownerId, card) {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const id = crypto.randomBytes(9).toString('base64url');
  pending.set(id, { ownerId, card, expires: now + 60 * 60 * 1000 });
  return id;
}
function take(ownerId, id) {
  const p = pending.get(String(id || ''));
  if (!p || p.ownerId !== ownerId || p.expires < Date.now()) return null;
  pending.delete(String(id));
  return p.card;
}

module.exports = { read, isCard, fieldsOf, pngTexts, keep, take };
