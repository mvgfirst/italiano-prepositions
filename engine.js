/* Движок тренажёра v2: данные пакетов, состояние, миграция, планировщик, отчёт.
 * Без обращения к DOM: работает и в браузере (window.Engine), и в Node (require / import) — так его проверяют юнит-тестами.
 *
 * Идентификатор пункта в приложении: "<packId>:<id пункта в пакете>", например "preposizioni:p01".
 * Состояние v2 хранится в localStorage под ключом KEY_V2. Ключ v1 (KEY_V1) движок только ЧИТАЕТ (для миграции) и никогда не пишет и не удаляет:
 * v1-данные остаются нетронутыми, это и есть откат. */
(function (root) {
'use strict';

var E = {};
E.KEY_V1 = 'preposizioni-v1';
E.KEY_V2 = 'preposizioni-v2';
E.KEY_PACKS = 'preposizioni-v2-packs';  // пакеты, импортированные файлом (отдельно от состояния: сброс занятий их не стирает)
E.STATE_VERSION = 2;
E.V1_PACK_ID = 'preposizioni';          // пакет, в который превратился банк v1
// Интервалы повторения (дни) по «коробкам» Лейтнера. Стартовая схема, не из источника; можно менять.
E.INTERVALS = [0, 1, 2, 4, 7, 14, 30];
E.MASTERED_BOX = 4;
E.TOPICS = {place: 'Место', time: 'Время', verb: 'Глагол + предлог', art: 'Слияния', other: 'Другое'};
E.TOPIC_LOW = {place: 'место', time: 'время', verb: 'глагол', art: 'слияние', other: 'другое'};
E.TOPIC_KEYS = ['place', 'time', 'verb', 'art', 'other'];
E.TYPES = ['gap', 'card'];               // gap — «вставь пропуск», card — карточка «слово + предлог»
E.KEEP_DAYS = 180;                       // сколько дней хранить события и подходы
E.ORIGINS = ['text', 'generated'];       // откуда пункт: из настоящего текста / сгенерирован
E.CHECKS = ['none', 'auto'];             // проверен ли автоматически
E.MAX_PACK_BYTES = 2 * 1024 * 1024;      // предел размера импортируемого пакета (защита от случайного файла)
E.MAX_TEXT = 300;                        // предел длины полей «ошибки с урока»

/* ================= Даты ================= */
function pad(n) { return String(n).padStart(2, '0'); }
E.ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
E.parse = function (s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
E.addDays = function (s, n) { var d = E.parse(s); d.setDate(d.getDate() + n); return E.ymd(d); };
E.isoWeek = function (s) {
  var l = E.parse(s);
  var d = new Date(Date.UTC(l.getFullYear(), l.getMonth(), l.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var w = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + pad(w);
};

/* ================= Пакеты ================= */
function isStr(x) { return typeof x === 'string' && x.length > 0; }

/* Проверка структуры пакета. Возвращает массив строк-ошибок (пустой = пакет годен). */
E.validatePack = function (p) {
  var err = [];
  if (!p || typeof p !== 'object') return ['пакет не объект'];
  if (!isStr(p.packId) || !/^[a-z0-9_-]+$/.test(p.packId)) err.push('packId: нужна строка из a-z, 0-9, _ и -');
  if (typeof p.version !== 'number' || p.version < 1) err.push('version: нужно число ≥ 1');
  if (!isStr(p.title)) err.push('title пустой');
  if (!Array.isArray(p.items) || !p.items.length) { err.push('items: нужен непустой список'); return err; }
  var ids = {};
  p.items.forEach(function (x, i) {
    var id = x && x.id, w = 'пункт ' + (isStr(id) ? id : '#' + i) + ': ';
    if (!x || typeof x !== 'object') { err.push(w + 'не объект'); return; }
    if (!isStr(id) || id.indexOf(':') >= 0) { err.push(w + 'id должен быть строкой без «:»'); return; }
    if (ids[id]) err.push(w + 'повторяется id'); ids[id] = true;
    if (E.TYPES.indexOf(x.type) < 0) { err.push(w + 'неизвестный type ' + x.type); return; }
    if (!E.TOPICS[x.topic]) err.push(w + 'неизвестный topic ' + x.topic);
    if (x.retired !== undefined && typeof x.retired !== 'boolean') err.push(w + 'retired должен быть true/false');
    if (!x.trust || E.ORIGINS.indexOf(x.trust.origin) < 0 || E.CHECKS.indexOf(x.trust.check) < 0) err.push(w + 'trust: нужны origin (' + E.ORIGINS.join('/') + ') и check (' + E.CHECKS.join('/') + ')');
    if (x.type === 'gap') {
      if (!isStr(x.ru) || !isStr(x.q) || !isStr(x.why)) err.push(w + 'пустое поле ru/q/why');
      else if ((x.q.match(/___/g) || []).length !== 1) err.push(w + 'в q должно быть ровно одно «___»');
      if (!Array.isArray(x.options) || x.options.length < 3 || x.options.length > 4) err.push(w + 'вариантов должно быть 3-4');
      else {
        if (x.options.some(function (o) { return !isStr(o); })) err.push(w + 'пустой вариант');
        if (x.options.filter(function (o, k) { return x.options.indexOf(o) !== k; }).length) err.push(w + 'повторяются варианты');
        if (x.options.indexOf(x.answer) < 0) err.push(w + 'правильного ответа нет среди вариантов');
      }
    } else {
      if (!isStr(x.front) || !isStr(x.back) || !isStr(x.example)) err.push(w + 'пустое поле front/back/example');
    }
  });
  return err;
};

/* Каталог: плоский список активных пакетов. Пункт получает key = packId:id.
 * Пакет с ошибками в каталог не попадает, ошибки возвращаются в .rejected. Два пакета с одним packId: берётся больший version. */
E.buildCatalog = function (packs) {
  var cat = {items: [], byKey: {}, packs: [], rejected: []};
  var best = {};
  (packs || []).forEach(function (p) {
    var errs = E.validatePack(p);
    if (errs.length) { cat.rejected.push({packId: p && p.packId, errors: errs}); return; }
    if (!best[p.packId] || best[p.packId].version < p.version) best[p.packId] = p;
  });
  Object.keys(best).forEach(function (pid) {
    var p = best[pid];
    cat.packs.push({packId: pid, version: p.version, title: p.title, level: p.level || '', source: p.source || '', license: p.license || '', count: p.items.length});
    p.items.forEach(function (x) {
      var it = Object.assign({}, x, {key: pid + ':' + x.id, packId: pid, retired: !!x.retired});
      cat.items.push(it); cat.byKey[it.key] = it;
    });
  });
  return cat;
};

/* ================= Импорт пакета файлом ================= */
/* Импортированные пакеты лежат под отдельным ключом KEY_PACKS: {v:1, packs:{<packId>: пакет}}.
 * Встроенные пакеты (packs/*.json в составе приложения) не меняются; пакет с тем же packId и бо́льшим version перекрывает встроенный (buildCatalog). */
function readPackBox(storage) {
  try {
    var r = storage.getItem(E.KEY_PACKS), o = r ? JSON.parse(r) : null;
    if (o && typeof o === 'object' && o.packs && typeof o.packs === 'object') return o;
  } catch (e) { /* битые или недоступные данные = пусто */ }
  return {v: 1, packs: {}};
}

/* Список импортированных пакетов (не проверенных: проверку делает buildCatalog). */
E.loadImportedPacks = function (storage) {
  var b = readPackBox(storage);
  return Object.keys(b.packs).map(function (k) { return b.packs[k]; });
};

/* Правила обновления пакета (одинаковы для импорта в приложении и для проверки перед выкладкой):
 * ОШИБКА — пункт исчез (удаление стирает статистику; вместо него retired: true), сменился type, изменился правильный ответ / обратная сторона карточки
 *          (значит, id переиспользован под другое содержание: нужен новый id).
 * ПРЕДУПРЕЖДЕНИЕ — изменился текст вопроса (q, ru) или лицевая сторона / пример карточки при том же ответе (допустимо для правки опечатки).
 * Разрешено без замечаний: поменять retired, topic, варианты ответа, пояснение. Это мои правила, не из источника. */
E.checkPackUpgrade = function (oldP, newP) {
  var errors = [], warnings = [], nm = {};
  newP.items.forEach(function (x) { nm[x.id] = x; });
  oldP.items.forEach(function (o) {
    var n = nm[o.id];
    if (!n) { errors.push(o.id + ': пункта нет в новой версии (удалять нельзя, статистика пропадёт; поставьте retired: true)'); return; }
    if (n.type !== o.type) { errors.push(o.id + ': сменился type (' + o.type + ' → ' + n.type + '), нужен новый id'); return; }
    if (o.type === 'gap') {
      if (n.answer !== o.answer) errors.push(o.id + ': изменился правильный ответ («' + o.answer + '» → «' + n.answer + '»), нужен новый id');
      else if (n.q !== o.q || n.ru !== o.ru) warnings.push(o.id + ': изменён текст вопроса при том же ответе (допустимо только для правки опечатки)');
    } else {
      if (n.back !== o.back) errors.push(o.id + ': изменилась обратная сторона карточки, нужен новый id');
      else if (n.front !== o.front || n.example !== o.example) warnings.push(o.id + ': изменён текст карточки при той же обратной стороне (допустимо только для правки опечатки)');
    }
  });
  return {errors: errors, warnings: warnings};
};

/* Импорт пакета из текста файла. known — пакеты, уже действующие в приложении (встроенные + импортированные).
 * Возвращает {ok, errors[], warnings[], packId, version, title, count, replaced}. Состояние занятий не трогается. */
E.importPack = function (storage, text, known) {
  var res = {ok: false, errors: [], warnings: []};
  if (typeof text !== 'string' || !text.trim()) { res.errors.push('файл пустой'); return res; }
  if (text.length > E.MAX_PACK_BYTES) { res.errors.push('файл слишком большой для пакета (больше ' + (E.MAX_PACK_BYTES / 1048576) + ' МБ)'); return res; }
  var p;
  try { p = JSON.parse(text); } catch (e) { res.errors.push('файл не похож на пакет: он не читается как JSON'); return res; }
  var ve = E.validatePack(p);
  if (ve.length) { res.errors = ve; return res; }
  var prev = null;
  (known || []).forEach(function (q) {
    if (q && q.packId === p.packId && Array.isArray(q.items) && (!prev || q.version > prev.version)) prev = q;
  });
  if (prev) {
    if (p.version <= prev.version) { res.errors.push('пакет «' + p.packId + '» версии ' + prev.version + ' уже установлен; импортируемая версия ' + p.version + ' не новее'); return res; }
    var u = E.checkPackUpgrade(prev, p);
    if (u.errors.length) { res.errors = u.errors; return res; }
    res.warnings = u.warnings; res.replaced = prev.version;
  }
  var box = readPackBox(storage);
  box.v = 1; box.packs[p.packId] = p;
  try { storage.setItem(E.KEY_PACKS, JSON.stringify(box)); }
  catch (e) { res.errors.push('не удалось сохранить пакет: память браузера недоступна или переполнена'); return res; }
  res.ok = true; res.packId = p.packId; res.version = p.version; res.title = p.title; res.count = p.items.length;
  return res;
};

/* Убрать импортированный пакет (откат импорта). Состояние занятий не трогается: статистика пунктов остаётся. Возвращает true, если пакет был. */
E.removeImportedPack = function (storage, packId) {
  var box = readPackBox(storage);
  if (!box.packs[packId]) return false;
  delete box.packs[packId];
  try { storage.setItem(E.KEY_PACKS, JSON.stringify(box)); return true; } catch (e) { return false; }
};

/* ================= Состояние ================= */
E.freshState = function () {
  return {v: 2, items: {}, events: [], sessions: [], lessonErrors: [], settings: {size: 5, cat: 'all', pack: 'all', tipHidden: false, lastBackup: null}};
};

function normalize(s) {
  var f = E.freshState();
  s.items = s.items || {}; s.events = s.events || []; s.sessions = s.sessions || [];
  if (!Array.isArray(s.lessonErrors)) s.lessonErrors = [];     // поле добавлено в 2.0 без смены номера версии: см. docs/План_Тренажёр_2.0.md, раздел 4
  s.settings = Object.assign(f.settings, s.settings || {});
  s.v = 2;
  return s;
}

/* Миграция v1 → v2. Чистая функция: v1-объект не изменяется. Ничего не теряет:
 * items (box, due, seen, wrong, lw), log → events, sessions, settings. */
E.migrateV1 = function (s1) {
  var pre = E.V1_PACK_ID + ':';
  var out = E.freshState();
  Object.keys(s1.items || {}).forEach(function (id) { out.items[pre + id] = Object.assign({}, s1.items[id]); });
  out.events = (s1.log || []).map(function (x) { return {d: x.d, ts: null, id: pre + x.id, ok: x.ok ? 1 : 0, ch: null, src: 'v1'}; });
  out.sessions = (s1.sessions || []).map(function (x) { return Object.assign({}, x); });
  out.settings = Object.assign(out.settings, s1.settings || {});
  return out;
};

/* Приводит любой разобранный объект (v1 или v2) к состоянию v2. null — если это не копия тренажёра. */
E.fromAnyVersion = function (obj) {
  if (!obj || typeof obj !== 'object' || !obj.items || typeof obj.items !== 'object') return null;
  if (obj.v === 2) return normalize(JSON.parse(JSON.stringify(obj)));
  if (obj.v === 1) return normalize(E.migrateV1(obj));
  return null;
};

/* Загрузка: v2 → иначе миграция из v1 (ключ v1 не трогаем) → иначе пустое состояние.
 * Возвращает {state, source: 'v2'|'migrated'|'fresh', storageOk}. */
E.loadState = function (storage) {
  var storageOk = true, res;
  function read(key) {
    try { var r = storage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { storageOk = false; return null; }
  }
  var s2 = read(E.KEY_V2);
  if (s2 && s2.v === 2 && s2.items) res = {state: normalize(s2), source: 'v2'};
  else {
    var s1 = read(E.KEY_V1);
    var m = s1 && s1.v === 1 ? E.fromAnyVersion(s1) : null;
    res = m ? {state: m, source: 'migrated'} : {state: E.freshState(), source: 'fresh'};
  }
  res.storageOk = storageOk;
  return res;
};

/* Сохранение: обрезает старые события и подходы. Пишет ТОЛЬКО в KEY_V2. Возвращает true при успехе. */
E.saveState = function (storage, state, today) {
  var cut = E.addDays(today, -E.KEEP_DAYS);
  state.events = state.events.filter(function (x) { return x.d >= cut; });
  state.sessions = state.sessions.filter(function (x) { return x.d >= cut; });
  state.lessonErrors = (state.lessonErrors || []).filter(function (x) { return x.d >= cut; });
  try { storage.setItem(E.KEY_V2, JSON.stringify(state)); return true; } catch (e) { return false; }
};

/* ================= Планировщик ================= */
/* Пункт участвует в подборе, если он не «retired» в пакете и не помечен в состоянии ни «сомневаюсь» (doubt), ни «рано» (early). */
E.isActive = function (state, it) {
  var st = state.items[it.key];
  return !it.retired && !(st && (st.doubt || st.early));
};

/* Очередь подхода: сначала то, что пора повторять, потом новое, потом остальное по близости срока.
 * mode: 'gap' | 'card'. rand — функция [0,1) (для тестов можно подставить свою). */
E.buildQueue = function (catalog, state, mode, today, rand) {
  rand = rand || Math.random;
  var size = state.settings.size, topic = state.settings.cat, pk = state.settings.pack || 'all';
  var pool = catalog.items.filter(function (x) {
    return x.type === mode && E.isActive(state, x) && (topic === 'all' || x.topic === topic) && (pk === 'all' || x.packId === pk);
  });
  for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  var st = function (x) { return state.items[x.key]; };
  var byDue = function (a, b) { return st(a).due < st(b).due ? -1 : st(a).due > st(b).due ? 1 : 0; };
  var due = pool.filter(function (x) { return st(x) && st(x).seen > 0 && st(x).due <= today; }).sort(byDue);
  var fresh = pool.filter(function (x) { return !st(x) || st(x).seen === 0; });
  var rest = pool.filter(function (x) { return st(x) && st(x).seen > 0 && st(x).due > today; }).sort(byDue);
  return due.concat(fresh).concat(rest).slice(0, size);
};

E.dueCount = function (catalog, state, today) {
  return catalog.items.filter(function (x) {
    var s = state.items[x.key];
    return E.isActive(state, x) && s && s.seen > 0 && s.due <= today;
  }).length;
};

E.masteredCount = function (catalog, state) {
  var n = 0, total = 0;
  catalog.items.forEach(function (x) {
    if (!E.isActive(state, x)) return;
    total++;
    var s = state.items[x.key];
    if (s && s.box >= E.MASTERED_BOX) n++;
  });
  return {mastered: n, total: total};
};

/* ================= Запись ответа ================= */
/* retry — повтор ошибки в том же подходе: расписание закрепляется, событие не пишется.
 * now — метка времени в мс (передаётся снаружи, чтобы тесты были детерминированными).
 * Возвращает записанное событие (чтобы интерфейс мог потом указать причину ошибки, см. setWhy) или null, если событие не писалось (retry). */
E.recordAnswer = function (state, it, ok, chosen, retry, today, now) {
  var s = state.items[it.key] || (state.items[it.key] = {box: 0, due: today, seen: 0, wrong: 0});
  if (retry) {
    if (ok) { s.box = 1; s.due = E.addDays(today, E.INTERVALS[1]); }
    return null;
  }
  s.seen++;
  if (ok) { s.box = Math.min(s.box + 1, E.INTERVALS.length - 1); s.due = E.addDays(today, E.INTERVALS[s.box]); }
  else { s.wrong++; s.box = 0; s.due = today; s.lw = chosen == null ? '' : chosen; }
  var ev = {d: today, ts: now == null ? null : now, id: it.key, ok: ok ? 1 : 0, ch: chosen == null ? null : chosen, src: 'app'};
  state.events.push(ev);
  return ev;
};

/* Причина ошибки («Почему?»): ev — событие, которое вернул recordAnswer; cat — одна из E.TOPIC_KEYS или null (стереть).
 * Причину можно указать только у события-ошибки. Возвращает true при успехе. */
E.setWhy = function (state, ev, cat) {
  if (!ev || ev.ok !== 0 || state.events.indexOf(ev) < 0) return false;
  if (cat === null || cat === undefined) { delete ev.why; return true; }
  if (E.TOPIC_KEYS.indexOf(cat) < 0) return false;
  ev.why = cat; return true;
};

function setFlag(state, key, flag, on, today) {
  var s = state.items[key] || (state.items[key] = {box: 0, due: today, seen: 0, wrong: 0});
  if (on) s[flag] = true; else delete s[flag];
}
/* «Сомневаюсь»: пункт выходит из подбора, статистика остаётся. on=false — вернуть. */
E.setDoubt = function (state, key, on, today) { setFlag(state, key, 'doubt', on, today); };
/* «Рано»: слово/пункт ещё не по уровню. Выходит из подбора так же, как «сомневаюсь», но попадает в список «на потом» (earlyList). on=false — вернуть. */
E.setEarly = function (state, key, on, today) { setFlag(state, key, 'early', on, today); };
/* Пункты, помеченные «рано» (только существующие в каталоге; пакет, которого нет в каталоге, не показывается). */
E.earlyList = function (catalog, state) {
  return catalog.items.filter(function (x) { var s = state.items[x.key]; return s && s.early; });
};

/* ================= Файл-копия: пакеты + прогресс в одном файле ================= */
/* Формат (мой, не из источника): {kind:'trainer-backup', v:1, created:'ГГГГ-ММ-ДД', packs:[пакеты целиком], state:{состояние v2}}.
 * Прогресс по пунктам уже привязан к пакету ключом packId:id; подходы, настройки и «ошибки с урока» общие, поэтому состояние одно на все пакеты.
 * Тот же файл-пакет без прогресса (то, что делает генератор) — обычный пакет: {packId, version, title, items…}. */
E.BACKUP_KIND = 'trainer-backup';
E.BACKUP_V = 1;

E.makeBackup = function (state, packs, today) {
  return {kind: E.BACKUP_KIND, v: E.BACKUP_V, created: today, packs: JSON.parse(JSON.stringify(packs || [])), state: JSON.parse(JSON.stringify(state))};
};

/* Разбор текста загруженного файла (уже распакованного). Возвращает {kind:'backup'|'pack'|'state', ...} или {kind:'error', error}.
 * 'state' — голая копия прогресса старого вида (v1 или v2, как давала прежняя кнопка «Скопировать копию»). */
E.parseUpload = function (text) {
  if (typeof text !== 'string' || !text.trim()) return {kind: 'error', error: 'файл пустой'};
  if (text.length > 4 * E.MAX_PACK_BYTES) return {kind: 'error', error: 'файл слишком большой для копии или пакета'};
  var o;
  try { o = JSON.parse(text); } catch (e) { return {kind: 'error', error: 'файл не читается (это не копия и не пакет тренажёра)'}; }
  if (!o || typeof o !== 'object') return {kind: 'error', error: 'файл не похож на копию или пакет тренажёра'};
  if (o.kind === E.BACKUP_KIND) {
    if (o.v !== E.BACKUP_V) return {kind: 'error', error: 'копия сделана другой версией тренажёра (формат ' + o.v + '), эта версия её не читает'};
    var st = E.fromAnyVersion(o.state);
    if (!st) return {kind: 'error', error: 'в копии нет прогресса или он повреждён'};
    if (!Array.isArray(o.packs)) return {kind: 'error', error: 'в копии нет списка пакетов'};
    return {kind: 'backup', created: o.created || '', packs: o.packs, state: st};
  }
  if (Array.isArray(o.items) && o.packId) return {kind: 'pack', text: text, pack: o};
  var s = E.fromAnyVersion(o);
  if (s) return {kind: 'state', state: s};
  return {kind: 'error', error: 'файл не похож на копию или пакет тренажёра'};
};

function evKey(x) { return [x.d, x.ts, x.id, x.ok, x.ch, x.src].join('|'); }
function uniqMerge(a, b, keyf, pick) {
  // Мультимножество: общее число одинаковых записей = максимум из двух списков (а не сумма и не «схлопывание»): повторы в одном дне настоящие.
  var cnt = {}, out = a.slice();
  a.forEach(function (x) { var k = keyf(x); cnt[k] = (cnt[k] || 0) + 1; });
  var seenB = {};
  b.forEach(function (x) {
    var k = keyf(x); seenB[k] = (seenB[k] || 0) + 1;
    if (seenB[k] > (cnt[k] || 0)) out.push(x);
    else if (pick) pick(a, x, k);
  });
  return out;
}

/* Слияние двух состояний (правила мои): a — текущее (побеждает при равенстве), b — из копии.
 * Пункт: берётся запись с бо́льшим seen (больше истории); при равенстве — текущая. Флаги doubt/early объединяются.
 * События и ошибки с урока — объединение без дублей; подходы — объединение, по дате; настройки — текущие. */
E.mergeState = function (a, b) {
  var out = JSON.parse(JSON.stringify(a)); b = JSON.parse(JSON.stringify(b));
  Object.keys(b.items).forEach(function (k) {
    var x = out.items[k], y = b.items[k];
    if (!x) { out.items[k] = y; return; }
    var win = (y.seen || 0) > (x.seen || 0) ? y : x, lose = win === y ? x : y;
    var m = Object.assign({}, win);
    ['doubt', 'early'].forEach(function (f) { if (win[f] || lose[f]) m[f] = true; });
    out.items[k] = m;
  });
  var evA = out.events;
  out.events = uniqMerge(evA, b.events, evKey, function (list, x) {
    if (x.why) { var t = list.filter(function (e) { return evKey(e) === evKey(x) && !e.why; })[0]; if (t) t.why = x.why; }
  });
  out.sessions = uniqMerge(out.sessions, b.sessions, function (x) { return JSON.stringify(x); });
  out.sessions.sort(function (p, q) { return p.d < q.d ? -1 : p.d > q.d ? 1 : 0; });
  out.lessonErrors = uniqMerge(out.lessonErrors || [], b.lessonErrors || [], function (x) { return [x.d, x.ts, x.was, x.should].join('|'); });
  return normalize(out);
};

/* Восстановление из разобранной копии (parseUpload → kind 'backup'|'state').
 * known — пакеты, уже действующие в приложении (встроенные + импортированные). mode: 'replace' | 'merge'.
 * Пакеты из копии: тот же packId и версия не новее — пропускаются (встроенное уже есть); новый или новее — ставятся по правилам importPack.
 * Состояние здесь НЕ сохраняется — его сохраняет вызывающий (saveState). Возвращает {ok, errors[], warnings[], state, installed[], skipped[]}.
 * Если установка пакета отвергнута (например, правила обновления), восстановление всё равно идёт: в warnings остаётся «пакет X не установлен». */
E.restoreBackup = function (storage, parsed, cur, mode, known) {
  var res = {ok: false, errors: [], warnings: [], installed: [], skipped: []};
  if (!parsed || (parsed.kind !== 'backup' && parsed.kind !== 'state')) { res.errors.push('это не копия'); return res; }
  var kn = (known || []).slice();
  (parsed.packs || []).forEach(function (p) {
    if (!p || typeof p !== 'object') return;
    var have = kn.filter(function (q) { return q && q.packId === p.packId; })[0];
    if (have && p.version <= have.version) { res.skipped.push(p.packId); return; }
    var r = E.importPack(storage, JSON.stringify(p), kn);
    if (r.ok) { res.installed.push(p.packId); kn.push(p); r.warnings.forEach(function (w) { res.warnings.push(p.packId + ': ' + w); }); }
    else res.warnings.push('пакет «' + (p.packId || '?') + '» не установлен: ' + r.errors.join('; '));
  });
  res.state = mode === 'merge' ? E.mergeState(cur, parsed.state) : parsed.state;
  res.ok = true;
  return res;
};

/* Распаковка/упаковка (gzip) встроенными средствами браузера и Node ≥ 18: DecompressionStream / CompressionStream.
 * В Safari на iPhone не проверено. Если их нет — понятная ошибка, а запись без сжатия работает всегда. */
E.bytesToText = function (buf) {
  var u = new Uint8Array(buf);
  var dec = new TextDecoder('utf-8');
  if (u.length > 2 && u[0] === 0x1f && u[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('этот браузер не умеет распаковывать .gz; загрузи файл .json'));
    var ds = new DecompressionStream('gzip');
    var w = ds.writable.getWriter(); w.write(u).catch(function () {}); w.close().catch(function () {});   // ошибки читаются из readable; здесь их гасим, чтобы не было необработанного отказа
    return new Response(ds.readable).arrayBuffer().then(function (b) { return dec.decode(b); });
  }
  return Promise.resolve(dec.decode(u));
};
E.textToGzip = function (text) {
  if (typeof CompressionStream === 'undefined') return Promise.reject(new Error('сжатие недоступно'));
  var cs = new CompressionStream('gzip');
  var w = cs.writable.getWriter(); w.write(new TextEncoder().encode(text)).catch(function () {}); w.close().catch(function () {});
  return new Response(cs.readable).arrayBuffer();
};

/* ================= Ошибки: тетрадь, ошибка с урока, разбор недели ================= */
function clip(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, E.MAX_TEXT); }

/* «Ошибка с урока»: ошибка, сделанная не в тренажёре. f = {was, should, cat, note}: было → надо → категория (по умолчанию «другое») + пояснение (необязательно).
 * Возвращает {ok:true, entry} или {ok:false, error}. */
E.addLessonError = function (state, f, today, now) {
  f = f || {};
  var was = clip(f.was), should = clip(f.should), note = clip(f.note);
  var cat = f.cat == null || f.cat === '' ? 'other' : f.cat;
  if (!was) return {ok: false, error: 'нужно написать, как было (что ты сказала или написала)'};
  if (!should) return {ok: false, error: 'нужно написать, как правильно'};
  if (E.TOPIC_KEYS.indexOf(cat) < 0) return {ok: false, error: 'неизвестная категория ' + cat};
  var entry = {d: today, ts: now == null ? null : now, was: was, should: should, cat: cat, src: 'lesson'};
  if (note) entry.note = note;
  if (!Array.isArray(state.lessonErrors)) state.lessonErrors = [];
  state.lessonErrors.push(entry);
  return {ok: true, entry: entry};
};

/* Ошибки за последние daysBack дней (по умолчанию 7, включая сегодня).
 * app — ошибки в тренажёре, по одной строке на пункт: {key, it, miss, lastD, ch (последний неверный выбор или null = «не знала»), why (последняя указанная причина или null),
 *       cat (причина, а если не указана — тема пункта), active}. Сортировка: больше ошибок → позже → по ключу.
 * lesson — ошибки с урока за то же окно, новые первыми. Пункты, которых нет в каталоге (пакет убран), пропускаются. */
E.weekErrors = function (catalog, state, today, daysBack) {
  var from = E.addDays(today, -((daysBack || 7) - 1)), g = {};
  state.events.forEach(function (ev) {
    if (ev.ok !== 0 || ev.d < from || ev.d > today) return;
    var it = catalog.byKey[ev.id]; if (!it) return;
    var r = g[ev.id] || (g[ev.id] = {key: ev.id, it: it, miss: 0, lastD: '', whyD: '', ch: null, why: null, active: E.isActive(state, it)});
    r.miss++;
    if (ev.d >= r.lastD) { r.lastD = ev.d; r.ch = ev.ch == null ? null : ev.ch; }     // «последняя» — по дате, не по порядку в массиве
    if (ev.why && ev.d >= r.whyD) { r.whyD = ev.d; r.why = ev.why; }
  });
  var app = Object.keys(g).map(function (k) { var r = g[k]; r.cat = r.why || r.it.topic; delete r.whyD; return r; });
  app.sort(function (a, b) { return b.miss - a.miss || (a.lastD < b.lastD ? 1 : a.lastD > b.lastD ? -1 : 0) || (a.key < b.key ? -1 : 1); });
  var lesson = (state.lessonErrors || []).filter(function (x) { return x.d >= from && x.d <= today; }).slice().reverse();
  return {app: app, lesson: lesson};
};

/* Очередь «Разбор недели»: только активные пункты, в которых за неделю была ошибка. Сначала менее освоенные (коробка ниже), затем с бо́льшим числом ошибок.
 * Длина — limit или настройка «размер подхода». Возвращает пункты каталога (как buildQueue). */
E.buildReviewQueue = function (catalog, state, today, limit) {
  var rows = E.weekErrors(catalog, state, today, 7).app.filter(function (r) { return r.active; });
  var box = function (r) { var s = state.items[r.key]; return s ? s.box : 0; };
  rows.sort(function (a, b) { return box(a) - box(b) || b.miss - a.miss || (a.key < b.key ? -1 : 1); });
  return rows.slice(0, limit || state.settings.size).map(function (r) { return r.it; });
};

/* Напоминание о копии: true, если занятия есть, а копию не делали (lastBackup пусто) или делали более BACKUP_NUDGE_DAYS дней назад.
 * Порог 14 дней — мой, не из источника. */
E.BACKUP_NUDGE_DAYS = 14;
E.backupNudge = function (state, today) {
  if (!state.events.length && !state.lessonErrors.length) return false;
  var lb = state.settings.lastBackup;
  if (!lb) return true;
  return lb < E.addDays(today, -E.BACKUP_NUDGE_DAYS);
};

/* ================= Статистика ================= */
E.streak = function (state, today) {
  var days = {};
  state.sessions.forEach(function (x) { days[x.d] = true; });
  var d = days[today] ? today : E.addDays(today, -1), n = 0;
  while (days[d]) { n++; d = E.addDays(d, -1); }
  return n;
};

E.accByTopic = function (catalog, state, daysBack, today) {
  var from = E.addDays(today, -(daysBack - 1)), r = {};
  E.TOPIC_KEYS.forEach(function (k) { r[k] = {n: 0, ok: 0}; });
  state.events.forEach(function (x) {
    if (x.d < from) return;
    var it = catalog.byKey[x.id]; if (!it) return;
    r[it.topic].n++; r[it.topic].ok += x.ok;
  });
  return r;
};

/* ================= Текст ================= */
E.fill = function (q, opt) {
  if (opt === '—') return q.replace(/ ?___/, '').replace(/\s+/g, ' ').trim();
  var i = q.indexOf('___');
  if (i < 0) return q;
  var after = q.slice(i + 3);
  if (/['\u2019]$/.test(opt)) after = after.replace(/^ /, '');   // «dall'» + « ufficio» → «dall'ufficio», без пробела после апострофа
  return q.slice(0, i) + opt + after;
};

/* ================= Журнал для Obsidian (этап 3 версии 2.0) =================
 * Один файл на ISO-неделю (пн–вс): «Тренажёр ГГГГ-Wнн.md». Файл создаётся целиком заново при каждой выгрузке (повторная выгрузка той же недели
 * даёт файл с тем же именем и заменяет прежний), поэтому в нём нет её собственных заметок: они остаются в «Журнал/ГГГГ-Wнн.md».
 * Поля Dataview: страничные — в YAML-шапке (week, sessions, answers, correct, acc, errors, lesson_errors); построчные — в конце строк списка в виде [ключ:: значение]. */
E.JOURNAL_FOLDER = 'Итальянский/Журнал/Тренажёр';
E.MODE_RU = {quiz: 'вопросы', cards: 'карточки', review: 'разбор'};
E.MAX_JOURNAL_ERRORS = 60;               // предел строк «ошибок недели» в одном файле (моё значение)

/* Неделя ISO по смещению: 0 — текущая, -1 — прошлая и т. д. Возвращает {week, from (понедельник), to (воскресенье или сегодня для текущей недели), days}.
 * days — число дней в окне [from, to] (для weekErrors: окно считается назад от to). */
E.weekRange = function (today, offset) {
  var wd = E.parse(today).getDay() || 7;                  // пн=1 … вс=7
  var monday = E.addDays(today, -(wd - 1) + 7 * (offset || 0));
  var sunday = E.addDays(monday, 6);
  var to = (offset || 0) === 0 ? today : sunday;
  var days = (offset || 0) === 0 ? wd : 7;
  return {week: E.isoWeek(monday), from: monday, to: to, days: days, sunday: sunday};
};
E.journalFileName = function (week) { return 'Тренажёр ' + week + '.md'; };

/* Текст для поля: без переводов строк и без того, что ломает поля Dataview ([ ] и ::) и разметку строки. */
E.fieldText = function (v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').replace(/::+/g, ':').trim();
};

/* Журнал недели. range — результат weekRange. Возвращает {empty, name, text, week, counts:{sessions, answers, correct, errors, lesson}}.
 * empty = true, если за окно нет ни ответов, ни подходов, ни ошибок с урока (файл не нужен). */
E.journalMd = function (catalog, state, range, exportedOn) {
  var from = range.from, to = range.to, T = E.fieldText;
  var ev = state.events.filter(function (x) { return x.d >= from && x.d <= to; });
  var ses = state.sessions.filter(function (x) { return x.d >= from && x.d <= to; });
  var we = E.weekErrors(catalog, state, to, range.days);
  var counts = {sessions: ses.length, answers: 0, correct: 0, errors: we.app.length, lesson: we.lesson.length};
  var by = {}; E.TOPIC_KEYS.forEach(function (k) { by[k] = {n: 0, ok: 0}; });
  ev.forEach(function (x) {
    var it = catalog.byKey[x.id]; if (!it) return;
    by[it.topic].n++; by[it.topic].ok += x.ok;
    counts.answers++; counts.correct += x.ok;
  });
  var name = E.journalFileName(range.week);
  if (!counts.answers && !counts.sessions && !counts.lesson) return {empty: true, name: name, text: '', week: range.week, counts: counts};

  var o = ['---', 'week: ' + range.week, 'period: "' + from + ' — ' + range.sunday + '"', 'sessions: ' + counts.sessions, 'answers: ' + counts.answers, 'correct: ' + counts.correct];
  if (counts.answers) o.push('acc: ' + Math.round(100 * counts.correct / counts.answers));
  o.push('errors: ' + (counts.errors + counts.lesson), 'lesson_errors: ' + counts.lesson, 'exported: ' + exportedOn, '---', '');
  o.push('# Тренажёр: ' + range.week, '');
  o.push('> Этот файл создаёт тренажёр, не правь его: при следующей выгрузке за эту неделю он будет заменён. Свои заметки пиши в `Журнал/' + range.week + '`.' +
    (to < range.sunday ? ' Неделя ещё идёт: данные по ' + to + '.' : ''), '');

  o.push('## Итоги по темам', '');
  if (counts.answers) {
    o.push('| Тема | Ответов | Верно | % |', '|---|---|---|---|');
    E.TOPIC_KEYS.forEach(function (k) {
      var a = by[k]; if (!a.n) return;
      o.push('| ' + E.TOPIC_LOW[k] + ' | ' + a.n + ' | ' + a.ok + ' | ' + Math.round(100 * a.ok / a.n) + ' |');
    });
    o.push('', 'Тема — это тема самого задания; в строках ошибок ниже категория — причина, которую ты выбрала («Почему?»), а если не выбирала — тема задания.', '');
  } else o.push('Ответов в тренажёре за эту неделю нет.', '');

  o.push('## Ошибки в тренажёре', '');
  var rows = we.app.slice(0, E.MAX_JOURNAL_ERRORS);
  if (rows.length) {
    rows.forEach(function (r) {
      var it = r.it, line = '- ';
      if (it.type === 'gap') {
        var was = r.ch == null ? 'не знала' : '«' + T(E.fill(it.q, r.ch)) + '»';
        line += 'Было: ' + was + ' → Надо: «' + T(E.fill(it.q, it.answer)) + '» · Почему: ' + T(it.why);
      } else {
        line += 'Карточка: «' + T(it.front) + '» → «' + T(it.back) + '» · Пример: ' + T(it.example);
      }
      o.push(line + ' [cat:: ' + E.TOPIC_LOW[r.cat] + '] [src:: тренажёр] [miss:: ' + r.miss + '] [day:: ' + r.lastD + ']');
    });
    if (we.app.length > rows.length) o.push('', '*Показаны ' + rows.length + ' из ' + we.app.length + ' пунктов с ошибками.*');
  } else o.push('Ошибок нет.');
  o.push('');

  o.push('## Ошибки с уроков', '');
  if (we.lesson.length) {
    we.lesson.forEach(function (r) {
      o.push('- Было: «' + T(r.was) + '» → Надо: «' + T(r.should) + '»' + (r.note ? ' · Почему: ' + T(r.note) : '') +
        ' [cat:: ' + E.TOPIC_LOW[r.cat] + '] [src:: урок] [day:: ' + r.d + ']');
    });
  } else o.push('Нет.');
  o.push('');

  o.push('## Подходы', '');
  if (ses.length) {
    ses.forEach(function (x) {
      var m = E.MODE_RU[x.mode] || T(x.mode || '');
      o.push('- ' + x.d + ' · ' + m + ' · ' + x.ok + ' из ' + x.n + ' [day:: ' + x.d + '] [mode:: ' + m + '] [n:: ' + x.n + '] [ok:: ' + x.ok + ']');
    });
  } else o.push('Подходов нет.');
  o.push('');
  return {empty: false, name: name, text: o.join('\n'), week: range.week, counts: counts};
};

if (typeof module !== 'undefined' && module.exports) module.exports = E; else root.Engine = E;
})(typeof window !== 'undefined' ? window : globalThis);
