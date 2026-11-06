/* 말씀노트 · Supabase 연결층
 * 원래 앱이 쓰던 window.claude.use("db" | "user" | "assets" | "downloads") 를
 * Supabase(Auth · Postgres · Realtime · Storage)로 그대로 구현합니다.
 * 덕분에 app.js 는 거의 손대지 않고 같은 동작(실시간 나눔 피드 등)을 유지합니다.
 */
(function () {
  "use strict";
  var C = window.MN_CONFIG;
  var sb = window.supabase.createClient(C.url, C.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  var MN = (window.MN = { sb: sb, me: null, account: null, settings: {} });

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function rid(n) {
    var A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", a = new Uint8Array(n), s = "";
    crypto.getRandomValues(a);
    for (var i = 0; i < n; i++) s += A[a[i] % A.length];
    return s;
  }
  function hex32() {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function plain(o) { return JSON.parse(JSON.stringify(o == null ? {} : o)); }
  function mkErr(e) { var x = new Error((e && e.message) || "error"); x.code = (e && e.code) || "error"; return x; }

  /* ================= DB (Firestore 비슷한 API) ================= */
  var TABLES = { entries: 1, prayers: 1, groups: 1, memberships: 1, profiles: 1, joinreqs: 1, prshares: 1, reactions: 1, comments: 1 };
  function tableOf(path) {
    if (TABLES[path]) return path;
    var m = /^data\/users\/[^/]+\/notes\/(prayers|meta)$/.exec(path);
    if (m) return m[1] === "meta" ? "user_meta" : "prayers";
    throw new Error("unknown collection: " + path);
  }
  var OWNED = { prayers: 1, user_meta: 1 }; // 본인 것만 읽는 표
  function rowFor(t, id, data) {
    var me = MN.me;
    if (t === "user_meta") return { uid: me, id: id, data: data };
    var uid = me;
    if (t === "groups") uid = data.createdBy || me;
    else if (/^(memberships|joinreqs|prshares|reactions|comments)$/.test(t)) uid = data.uid || me;
    if (t === "entries" && !data.uid) data.uid = me;
    return { id: id, uid: uid, gid: data.gid || null, data: data };
  }

  var feeds = {};
  function feed(t) {
    if (feeds[t]) return feeds[t];
    var f = (feeds[t] = { t: t, ls: [], timer: 0, seq: 0, last: null, ch: null });
    f.ch = sb.channel("mn-" + t)
      .on("postgres_changes", { event: "*", schema: "public", table: t }, function () { schedule(t, 350); })
      .subscribe(function (status) { if (status === "SUBSCRIBED" && f.last) schedule(t, 0); });
    return f;
  }
  async function fetchAll(t) {
    var out = [], from = 0, step = 1000;
    for (;;) {
      var q = sb.from(t).select("id,data").range(from, from + step - 1);
      if (OWNED[t]) q = q.eq("uid", MN.me);
      var r = await q;
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < step) break;
      from += step;
    }
    return out;
  }
  function snapOf(rows) {
    return { docs: rows.map(function (r) { return { id: r.id, data: function () { return r.data || {}; } }; }), size: rows.length };
  }
  function schedule(t, delay) {
    var f = feeds[t]; if (!f) return;
    clearTimeout(f.timer);
    f.timer = setTimeout(function () {
      var my = ++f.seq;
      fetchAll(t).then(function (rows) {
        if (my !== f.seq) return;
        f.last = rows;
        f.ls.slice().forEach(function (l) { try { l.cb(snapOf(rows)); } catch (e) { console.error(e); } });
      }, function (err) {
        console.warn("[mn] fetch " + t, err);
        f.ls.forEach(function (l) { if (!l.got && l.err) { l.got = true; try { l.err(mkErr(err)); } catch (e) {} } });
      });
    }, delay == null ? 200 : delay);
  }
  MN.refresh = function (t) { if (feeds[t]) schedule(t, 0); };
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") Object.keys(feeds).forEach(function (t) { schedule(t, 0); });
  });
  window.addEventListener("online", function () { Object.keys(feeds).forEach(function (t) { schedule(t, 0); }); });

  function docRef(t, id) {
    id = id || rid(20);
    return {
      id: id,
      get: async function () {
        var q = sb.from(t).select("id,data").eq("id", id);
        if (t === "user_meta") q = q.eq("uid", MN.me);
        var r = await q.maybeSingle();
        if (r.error) throw mkErr(r.error);
        var d = r.data;
        return { id: id, exists: !!d, data: function () { return d ? d.data : undefined; } };
      },
      set: async function (data) {
        var row = rowFor(t, id, plain(data));
        var r = await sb.from(t).upsert(row, { onConflict: t === "user_meta" ? "uid,id" : "id" });
        if (r.error) throw mkErr(r.error);
        schedule(t, 150);
      },
      update: async function (patch) {
        var r;
        if (t === "user_meta") {
          var cur = await sb.from(t).select("data").eq("uid", MN.me).eq("id", id).maybeSingle();
          if (cur.error) throw mkErr(cur.error);
          r = await sb.from(t).upsert({ uid: MN.me, id: id, data: Object.assign({}, cur.data && cur.data.data, plain(patch)) }, { onConflict: "uid,id" });
        } else r = await sb.rpc("doc_patch", { p_table: t, p_id: id, p_patch: plain(patch) });
        if (r.error) throw mkErr(r.error);
        schedule(t, 150);
      },
      delete: async function () {
        var q = sb.from(t).delete().eq("id", id);
        if (t === "user_meta") q = q.eq("uid", MN.me);
        var r = await q;
        if (r.error) throw mkErr(r.error);
        schedule(t, 150);
      }
    };
  }
  var DB = {
    collection: function (path) {
      var t = tableOf(path);
      return {
        doc: function (id) { return docRef(t, id); },
        add: async function (data) { var d = docRef(t); await d.set(data); return d; },
        onSnapshot: function (cb, err) {
          var f = feed(t), l = { cb: cb, err: err, got: false };
          f.ls.push(l);
          if (f.last) { var rows = f.last; setTimeout(function () { cb(snapOf(rows)); }, 0); }
          schedule(t, 0);
          return function () { f.ls = f.ls.filter(function (x) { return x !== l; }); };
        }
      };
    }
  };

  /* ================= user ================= */
  var USERAPI = {
    id: async function () { return MN.me; },
    isOwner: async function () { return !!(MN.account && MN.account.role === "admin"); },
    can: async function () { return true; },
    canEdit: async function () { return true; },
    profiles: async function (ids) {
      var out = {};
      ids = (ids || []).filter(function (x) { return /^[0-9a-f-]{36}$/i.test(x); });
      if (!ids.length) return out;
      var r = await sb.from("accounts").select("id,display_name,color").in("id", ids);
      (r.data || []).forEach(function (a) { out[a.id] = { name: a.display_name || "멤버", color: a.color || undefined }; });
      return out;
    }
  };

  /* ================= assets (사진) ================= */
  MN.photoUrl = function (id) { return C.url + "/storage/v1/object/public/photos/p/" + id; };
  var ASSETAPI = {
    upload: async function (blob, opt) {
      var id = hex32();
      var r = await sb.storage.from("photos").upload("p/" + id, blob, { contentType: (opt && opt.type) || blob.type || "image/jpeg", upsert: false });
      if (r.error) throw mkErr(r.error);
      return { id: id };
    },
    delete: async function (id) { await sb.storage.from("photos").remove(["p/" + id]); }
  };

  /* ================= downloads ================= */
  var DLAPI = {
    save: async function (o) {
      var blob = new Blob([o.data], { type: /\.json$/i.test(o.filename) ? "application/json" : "text/plain;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = o.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }
  };

  window.claude = {
    use: function (name) {
      if (name === "db") return Promise.resolve(DB);
      if (name === "user") return Promise.resolve(USERAPI);
      if (name === "assets") return Promise.resolve(ASSETAPI);
      if (name === "downloads") return Promise.resolve(DLAPI);
      return Promise.reject(new Error("unavailable"));
    }
  };

  MN.signOut = async function () {
    try { await sb.auth.signOut(); } catch (e) {}
    try { ["qt-open", "qt-mottos"].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
    location.replace(location.pathname);
  };

  MN.joinByCode = async function (code) {
    var r = await sb.rpc("join_group_by_code", { p_code: code });
    if (r.error) throw r.error;
    return r.data || null;
  };

  /* ================= 백업 가져오기 ================= */
  function cleanDoc(o) {
    var c = {};
    for (var k in o) { if (k.charAt(0) === "_" || k === "id") continue; c[k] = o[k]; }
    return plain(c);
  }
  function parseBackup(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { throw new Error("JSON 파일이 아니에요. 「전체 백업(.json)」으로 받은 파일을 골라 주세요."); }
    if (!o || typeof o !== "object" || (o.app && o.app !== "말씀노트") || (!Array.isArray(o.entries) && !Array.isArray(o.prayers)))
      throw new Error("말씀노트 백업 파일이 아니에요.");
    return {
      exportedAt: o.exportedAt || "",
      profile: o.profile && typeof o.profile === "object" ? o.profile : null,
      mottos: o.mottos && typeof o.mottos === "object" ? o.mottos : {},
      entries: (o.entries || []).filter(function (e) { return e && typeof e === "object"; }),
      prayers: (o.prayers || []).filter(function (p) { return p && typeof p === "object"; })
    };
  }
  async function existingIds(t) {
    var r = await sb.from(t).select("id").eq("uid", MN.me);
    var s = {}; (r.data || []).forEach(function (x) { s[x.id] = 1; }); return s;
  }
  async function upsertRows(t, rows, onProgress) {
    var done = 0, fails = 0;
    for (var i = 0; i < rows.length; i += 100) {
      var chunk = rows.slice(i, i + 100);
      var r = await sb.from(t).upsert(chunk, { onConflict: "id" });
      if (r.error) {
        // 다른 계정의 기록과 id가 겹치는 드문 경우: 새 id로 하나씩 넣기
        for (var j = 0; j < chunk.length; j++) {
          var one = await sb.from(t).upsert(chunk[j], { onConflict: "id" });
          if (one.error) { chunk[j].id = rid(20); one = await sb.from(t).insert(chunk[j]); }
          if (one.error) fails++; else done++;
        }
      } else done += chunk.length;
      if (onProgress) onProgress(t, done, rows.length);
    }
    return { done: done, fails: fails };
  }
  MN.importBackup = async function (bk, overwrite, onProgress) {
    var me = MN.me, res = { entries: 0, prayers: 0, skipped: 0, fails: 0, motto: false, profile: false };
    var haveE = overwrite ? {} : await existingIds("entries"), haveP = overwrite ? {} : await existingIds("prayers");
    var er = [], pr = [];
    bk.entries.forEach(function (e) {
      var id = String(e.id || rid(20));
      if (haveE[id]) { res.skipped++; return; }
      var d = cleanDoc(e); d.uid = me; if (!Array.isArray(d.blocks)) d.blocks = [];
      er.push({ id: id, uid: me, gid: null, data: d });
    });
    bk.prayers.forEach(function (p) {
      var id = String(p.id || rid(20));
      if (haveP[id]) { res.skipped++; return; }
      var d = cleanDoc(p);
      // 사진은 백업 파일에 들어 있지 않으므로 사진 칸은 비우고, 글이 없는 사진 블록은 뺍니다
      d.blocks = (Array.isArray(d.blocks) ? d.blocks : []).filter(function (b) {
        return b && (b.type !== "img" || String(b.text || "").trim());
      }).map(function (b) { if (b.type === "img") b.images = []; return b; });
      pr.push({ id: id, uid: me, gid: null, data: d });
    });
    var a = await upsertRows("entries", er, onProgress); res.entries = a.done; res.fails += a.fails;
    var b = await upsertRows("prayers", pr, onProgress); res.prayers = b.done; res.fails += b.fails;
    if (Object.keys(bk.mottos).length) {
      var cur = await sb.from("user_meta").select("data").eq("uid", me).eq("id", "motto").maybeSingle();
      if (overwrite || !cur.data) {
        var m = Object.assign({}, cur.data && cur.data.data, plain(bk.mottos));
        var mr = await sb.from("user_meta").upsert({ uid: me, id: "motto", data: m }, { onConflict: "uid,id" });
        res.motto = !mr.error;
      }
    }
    if (bk.profile && (bk.profile.role || bk.profile.bio)) {
      var cp = await sb.from("profiles").select("id").eq("id", me).maybeSingle();
      if (overwrite || !cp.data) {
        var pp = await sb.from("profiles").upsert({ id: me, uid: me, gid: null, data: { role: String(bk.profile.role || ""), bio: String(bk.profile.bio || ""), updatedAt: new Date().toISOString() } }, { onConflict: "id" });
        res.profile = !pp.error;
      }
    }
    ["entries", "prayers", "user_meta", "profiles"].forEach(MN.refresh);
    return res;
  };

  /* ================= 설정 창에 붙는 부분 ================= */
  MN.settingsHTML = function () {
    var a = MN.account || {};
    return '<section class="setsec mnset"><h4>계정</h4>' +
      '<p class="pssub">' + esc(a.email || "") + (a.role === "admin" ? ' · <b>관리자</b>' : "") + '</p>' +
      '<label class="f" for="mn-name">이름 (나눔 그룹에 보이는 이름)</label>' +
      '<div class="mnrow"><input type="text" id="mn-name" maxlength="40" value="' + esc(a.display_name || "") + '"><button type="button" class="btn" id="mn-name-save">이름 저장</button></div>' +
      '<label class="f" for="mn-pw">새 비밀번호</label>' +
      '<div class="mnrow"><input type="password" id="mn-pw" minlength="6" autocomplete="new-password" placeholder="6자 이상"><button type="button" class="btn" id="mn-pw-save">비밀번호 바꾸기</button></div>' +
      '<div class="mnrow mnacts">' + (a.role === "admin" ? '<a class="btn primary" href="admin.html">관리자 페이지</a>' : "") + '<button type="button" class="btn danger" id="mn-logout">로그아웃</button></div>' +
      '<p class="setmsg" id="mn-acc-msg" aria-live="polite"></p></section>' +
      '<section class="setsec mnset"><h4>백업 가져오기</h4>' +
      '<p class="pssub">Claude에서 쓰던 말씀노트의 <b>설정 → 백업 내보내기 → 전체 백업(.json)</b> 파일을 올리면, 그 기록을 이 계정으로 그대로 옮겨 이어서 쓸 수 있어요.</p>' +
      '<input type="file" id="mn-file" accept=".json,application/json" class="mnfile">' +
      '<div id="mn-prev" class="mnprev" hidden></div>' +
      '<label class="mnchk"><input type="checkbox" id="mn-over" checked> 같은 기록이 이미 있으면 백업 내용으로 덮어쓰기</label>' +
      '<div class="mnrow"><button type="button" class="btn primary" id="mn-import" disabled>가져오기</button></div>' +
      '<p class="setnote">사진은 백업 파일에 들어 있지 않아 옮겨지지 않아요. 나눔 그룹은 새 사이트에서 다시 만들거나 참여해 주세요.</p>' +
      '<p class="setmsg" id="mn-imp-msg" aria-live="polite"></p></section>';
  };
  MN.wireSettings = function (d) {
    var accMsg = d.querySelector("#mn-acc-msg"), impMsg = d.querySelector("#mn-imp-msg");
    d.querySelector("#mn-name-save").addEventListener("click", async function () {
      var n = d.querySelector("#mn-name").value.trim();
      if (!n) { accMsg.textContent = "이름을 적어 주세요."; return; }
      var r = await sb.rpc("update_my_account", { p_name: n });
      if (r.error) { accMsg.textContent = "이름을 저장하지 못했어요."; return; }
      MN.account.display_name = n; accMsg.textContent = "이름을 바꿨어요.";
      if (MN.onNameChange) MN.onNameChange();
    });
    d.querySelector("#mn-pw-save").addEventListener("click", async function () {
      var p = d.querySelector("#mn-pw").value;
      if (p.length < 6) { accMsg.textContent = "비밀번호는 6자 이상이어야 해요."; return; }
      var r = await sb.auth.updateUser({ password: p });
      accMsg.textContent = r.error ? "비밀번호를 바꾸지 못했어요: " + r.error.message : "비밀번호를 바꿨어요.";
      if (!r.error) d.querySelector("#mn-pw").value = "";
    });
    d.querySelector("#mn-logout").addEventListener("click", function () { MN.signOut(); });

    var bk = null, file = d.querySelector("#mn-file"), prev = d.querySelector("#mn-prev"), go = d.querySelector("#mn-import");
    file.addEventListener("change", async function () {
      bk = null; go.disabled = true; prev.hidden = true; impMsg.textContent = "";
      var f = file.files && file.files[0]; if (!f) return;
      try {
        bk = parseBackup(await f.text());
        prev.hidden = false;
        prev.innerHTML = '<b>' + esc(f.name) + '</b><span>말씀노트 ' + bk.entries.length + '개 · 기도 ' + bk.prayers.length + '개' +
          (bk.exportedAt ? ' · ' + esc(bk.exportedAt.slice(0, 10)) + ' 백업' : '') + '</span>';
        go.disabled = !(bk.entries.length || bk.prayers.length || Object.keys(bk.mottos).length);
      } catch (e) { impMsg.textContent = e.message; }
    });
    go.addEventListener("click", async function () {
      if (!bk) return;
      go.disabled = true; file.disabled = true; impMsg.textContent = "가져오는 중…";
      try {
        var r = await MN.importBackup(bk, d.querySelector("#mn-over").checked, function (t, n, all) {
          impMsg.textContent = (t === "entries" ? "말씀노트" : "기도") + " 가져오는 중… " + n + " / " + all;
        });
        impMsg.textContent = "다 가져왔어요. 말씀노트 " + r.entries + "개 · 기도 " + r.prayers + "개" +
          (r.skipped ? " (이미 있던 " + r.skipped + "개는 건너뜀)" : "") + (r.fails ? " · " + r.fails + "개는 실패" : "") + ".";
      } catch (e) { impMsg.textContent = "가져오지 못했어요: " + (e.message || e); }
      file.disabled = false; go.disabled = false;
    });
  };

  /* ================= 로그인 화면 ================= */
  var gate = document.getElementById("mngate"), box = document.getElementById("mnbox");
  function show(html) { gate.hidden = false; box.innerHTML = html; }
  function notice() { var n = MN.settings.notice; return n ? '<p class="mnnotice">' + esc(n) + '</p>' : ""; }
  var HEAD = '<div class="mnlogo"><span class="mnmark">말씀노트</span><small>QT · 기도 · 나눔</small></div>';
  function redirect() { return location.origin + location.pathname; }

  function viewLogin(msg, email) {
    show(HEAD + notice() +
      '<form id="mnf" class="mnform" novalidate><label for="mn-em">이메일</label><input id="mn-em" type="email" autocomplete="email" required value="' + esc(email || "") + '">' +
      '<label for="mn-pw1">비밀번호</label><input id="mn-pw1" type="password" autocomplete="current-password" required>' +
      '<button class="btn primary mnbig" type="submit">로그인</button><p class="mnmsg" aria-live="polite">' + esc(msg || "") + '</p></form>' +
      '<div class="mnlinks">' + (MN.settings.signup_open === false ? '<span>지금은 새 가입을 받지 않아요</span>' : '<button type="button" data-v="signup">처음이신가요? 가입하기</button>') +
      '<button type="button" data-v="reset">비밀번호를 잊었어요</button></div>');
    var f = box.querySelector("#mnf");
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var em = f.querySelector("#mn-em").value.trim(), pw = f.querySelector("#mn-pw1").value, m = f.querySelector(".mnmsg");
      if (!em || !pw) { m.textContent = "이메일과 비밀번호를 적어 주세요."; return; }
      m.textContent = "로그인 중…";
      var r = await sb.auth.signInWithPassword({ email: em, password: pw });
      if (r.error) {
        var t = r.error.message || "";
        if (/confirm/i.test(t)) { viewCheckMail(em, "아직 이메일 인증을 하지 않았어요. 메일함의 인증 링크를 눌러 주세요."); return; }
        m.textContent = /invalid/i.test(t) ? "이메일 또는 비밀번호가 맞지 않아요." : "로그인하지 못했어요: " + t;
        return;
      }
      afterAuth(r.data.session);
    });
    wireLinks();
    setTimeout(function () { var i = box.querySelector(email ? "#mn-pw1" : "#mn-em"); if (i) i.focus(); }, 30);
  }
  function viewSignup() {
    show(HEAD + notice() +
      '<form id="mnf" class="mnform" novalidate><label for="mn-nm">이름</label><input id="mn-nm" type="text" maxlength="40" autocomplete="name" placeholder="나눔 그룹에 보일 이름" required>' +
      '<label for="mn-em">이메일</label><input id="mn-em" type="email" autocomplete="email" required>' +
      '<label for="mn-pw1">비밀번호</label><input id="mn-pw1" type="password" autocomplete="new-password" placeholder="6자 이상" required>' +
      '<label for="mn-pw2">비밀번호 확인</label><input id="mn-pw2" type="password" autocomplete="new-password" required>' +
      '<button class="btn primary mnbig" type="submit">가입 신청</button><p class="mnhint">가입하면 관리자가 확인한 뒤 사용할 수 있어요.</p><p class="mnmsg" aria-live="polite"></p></form>' +
      '<div class="mnlinks"><button type="button" data-v="login">이미 계정이 있어요. 로그인</button></div>');
    var f = box.querySelector("#mnf");
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var nm = f.querySelector("#mn-nm").value.trim(), em = f.querySelector("#mn-em").value.trim(),
        p1 = f.querySelector("#mn-pw1").value, p2 = f.querySelector("#mn-pw2").value, m = f.querySelector(".mnmsg");
      if (!nm || !em) { m.textContent = "이름과 이메일을 적어 주세요."; return; }
      if (p1.length < 6) { m.textContent = "비밀번호는 6자 이상이어야 해요."; return; }
      if (p1 !== p2) { m.textContent = "비밀번호 확인이 서로 달라요."; return; }
      m.textContent = "가입하는 중…";
      var r = await sb.auth.signUp({ email: em, password: p1, options: { data: { name: nm }, emailRedirectTo: redirect() } });
      if (r.error) {
        var t = r.error.message || "";
        m.textContent = /registered|exists/i.test(t) ? "이미 가입된 이메일이에요. 로그인해 주세요." :
          /database error/i.test(t) ? "지금은 새 가입을 받지 않고 있어요." : "가입하지 못했어요: " + t;
        return;
      }
      if (!r.data.session) { viewCheckMail(em); return; }
      afterAuth(r.data.session);
    });
    wireLinks();
    setTimeout(function () { box.querySelector("#mn-nm").focus(); }, 30);
  }
  function viewReset() {
    show(HEAD + '<form id="mnf" class="mnform" novalidate><p class="mnhint">가입한 이메일로 비밀번호를 다시 정하는 링크를 보내 드려요.</p>' +
      '<label for="mn-em">이메일</label><input id="mn-em" type="email" autocomplete="email" required>' +
      '<button class="btn primary mnbig" type="submit">링크 보내기</button><p class="mnmsg" aria-live="polite"></p></form>' +
      '<div class="mnlinks"><button type="button" data-v="login">로그인으로 돌아가기</button></div>');
    var f = box.querySelector("#mnf");
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var em = f.querySelector("#mn-em").value.trim(), m = f.querySelector(".mnmsg");
      if (!em) return;
      var r = await sb.auth.resetPasswordForEmail(em, { redirectTo: redirect() });
      m.textContent = r.error ? "보내지 못했어요: " + r.error.message : "메일을 보냈어요. 메일함을 확인해 주세요.";
    });
    wireLinks();
  }
  function viewNewPassword() {
    show(HEAD + '<form id="mnf" class="mnform" novalidate><p class="mnhint">새 비밀번호를 정해 주세요.</p>' +
      '<label for="mn-pw1">새 비밀번호</label><input id="mn-pw1" type="password" autocomplete="new-password" placeholder="6자 이상">' +
      '<button class="btn primary mnbig" type="submit">저장</button><p class="mnmsg" aria-live="polite"></p></form>');
    var f = box.querySelector("#mnf");
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var p = f.querySelector("#mn-pw1").value, m = f.querySelector(".mnmsg");
      if (p.length < 6) { m.textContent = "6자 이상으로 적어 주세요."; return; }
      var r = await sb.auth.updateUser({ password: p });
      if (r.error) { m.textContent = "저장하지 못했어요: " + r.error.message; return; }
      var s = await sb.auth.getSession(); afterAuth(s.data.session);
    });
  }
  function viewCheckMail(email, msg) {
    show(HEAD + '<div class="mnstate"><b>메일함을 확인해 주세요</b><p>' + esc(msg || (email + " 로 인증 메일을 보냈어요. 메일의 링크를 누르면 가입이 마무리돼요.")) + '</p>' +
      '<button type="button" class="btn" id="mn-resend">인증 메일 다시 보내기</button><p class="mnmsg" aria-live="polite"></p></div>' +
      '<div class="mnlinks"><button type="button" data-v="login">로그인으로 돌아가기</button></div>');
    box.querySelector("#mn-resend").addEventListener("click", async function () {
      var r = await sb.auth.resend({ type: "signup", email: email, options: { emailRedirectTo: redirect() } });
      box.querySelector(".mnmsg").textContent = r.error ? "보내지 못했어요: " + r.error.message : "다시 보냈어요.";
    });
    wireLinks();
  }
  var waitTimer = 0, waitCh = null;
  function viewStatus(a) {
    var T = {
      pending: ["가입 승인을 기다리고 있어요", "관리자가 확인하면 바로 쓸 수 있어요. 이 화면을 열어 두면 승인되는 순간 자동으로 들어가집니다."],
      rejected: ["가입이 승인되지 않았어요", "궁금한 점은 관리자에게 문의해 주세요."],
      suspended: ["이용이 잠시 멈춘 계정이에요", "관리자에게 문의해 주세요."]
    }[a.status] || ["계정 상태를 확인할 수 없어요", ""];
    show(HEAD + notice() + '<div class="mnstate"><b>' + T[0] + '</b><p>' + T[1] + '</p><p class="mnwho">' + esc(a.display_name) + ' · ' + esc(a.email) + '</p>' +
      '<div class="mnrow"><button type="button" class="btn" id="mn-check">다시 확인</button><button type="button" class="btn" id="mn-out">로그아웃</button></div></div>');
    box.querySelector("#mn-check").addEventListener("click", function () { loadAccount(); });
    box.querySelector("#mn-out").addEventListener("click", async function () { await sb.auth.signOut(); location.reload(); });
    if (a.status === "pending") {
      clearInterval(waitTimer); waitTimer = setInterval(loadAccount, 20000);
      if (!waitCh) waitCh = sb.channel("mn-me").on("postgres_changes", { event: "UPDATE", schema: "public", table: "accounts", filter: "id=eq." + a.id }, function () { loadAccount(); }).subscribe();
    }
  }
  function wireLinks() {
    box.querySelectorAll("[data-v]").forEach(function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute("data-v");
        if (v === "signup") viewSignup(); else if (v === "reset") viewReset(); else viewLogin();
      });
    });
  }

  var booted = false;
  async function loadAccount() {
    var r = await sb.from("accounts").select("*").eq("id", MN.me).maybeSingle();
    if (r.error || !r.data) {
      show(HEAD + '<div class="mnstate"><b>계정 정보를 불러오지 못했어요</b><p>잠시 후 다시 열어 주세요.</p><button type="button" class="btn" id="mn-out">로그아웃</button></div>');
      box.querySelector("#mn-out").addEventListener("click", async function () { await sb.auth.signOut(); location.reload(); });
      return;
    }
    MN.account = r.data;
    if (r.data.status === "approved") boot(); else viewStatus(r.data);
  }
  function afterAuth(session) {
    if (!session) { viewLogin(); return; }
    MN.me = session.user.id;
    loadAccount();
  }
  function boot() {
    if (booted) return; booted = true;
    clearInterval(waitTimer); if (waitCh) { sb.removeChannel(waitCh); waitCh = null; }
    gate.hidden = true; document.documentElement.classList.remove("mnlocked");
    var s = document.createElement("script"); s.src = "app.js?v=" + (window.MN_VERSION || "1"); document.body.appendChild(s);
    var n = MN.settings.notice;
    if (n) {
      var key = "mn-notice-seen"; var seen = null; try { seen = localStorage.getItem(key); } catch (e) {}
      if (seen !== n) {
        var bar = document.createElement("div"); bar.className = "mnbar"; bar.setAttribute("role", "status");
        bar.innerHTML = '<span>' + esc(n) + '</span><button type="button" aria-label="공지 닫기">×</button>';
        bar.querySelector("button").addEventListener("click", function () { bar.remove(); try { localStorage.setItem(key, n); } catch (e) {} });
        document.body.appendChild(bar);
      }
    }
  }

  (async function start() {
    show('<div class="mnstate"><p>불러오는 중…</p></div>');
    try {
      var st = await sb.from("app_settings").select("key,value");
      (st.data || []).forEach(function (x) { MN.settings[x.key] = x.value; });
    } catch (e) {}
    var recovering = /type=recovery/.test(location.hash);
    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === "PASSWORD_RECOVERY") { recovering = true; MN.me = session && session.user.id; viewNewPassword(); }
      else if (ev === "SIGNED_OUT" && booted) location.reload();
    });
    var s = await sb.auth.getSession();
    if (recovering) return;
    afterAuth(s.data.session);
  })();
})();
