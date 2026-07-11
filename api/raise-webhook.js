// ═══════════════════════════════════════════════════════════════
// RECOMLINKED — Google Apps Script Webhook Handler
// ═══════════════════════════════════════════════════════════════
// TABS: Raise Sessions | Offer Sessions | Leads | Waitlist
//
// TO SET UP: paste this file, then run setupAllTabs() once.
// TO TEST:   run testRaiseLog() and testOfferLog()
// ═══════════════════════════════════════════════════════════════

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'getCourses') return getCourses();
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var raw = e.postData.contents;
    var data = JSON.parse(raw);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');

    Logger.log('doPost: event=' + data.event + ' product=' + data.product + ' stage=' + data.stage + ' sid=' + data.session_id);
    if (data.event === 'RAISE_SESSION') {
      if (data.product === 'offer') return handleOfferSession(data, ss, now);
      return handleRaiseSession(data, ss, now);
    }
    if (data.event === 'WAITLIST_NOTIFY' || data.event === 'WAITLIST_SUGGEST') {
      return handleWaitlist(data, ss, now);
    }
    return handleLead(data, ss, now);
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
// RAISE SESSIONS — one row per session_id
// Columns (23): Date | User ID | Session ID | Prev Session ID |
//   Role | Seniority | Template | Mode | Download PDF |
//   Blocker Code | Blocker Label | Paywall Seen | Paywall Action |
//   Deep Dive Gaps | Deep Dive Qs | Free Text Count | Landing Ref |
//   Source | Duration (s) | Last Stage | Updated At |
//   Video Watched | Video Completed
// ═══════════════════════════════════════════════════════════════

function handleRaiseSession(data, ss, now) {
  var sheet = ss.getSheetByName('Raise Sessions');
  if (!sheet) {
    sheet = ss.insertSheet('Raise Sessions');
    formatRaiseHeaders(sheet);
  }

  var sid = data.session_id || '';
  if (!sid) return jsonOk();

  // Find existing row or create new one
  var row = findRow(sheet, sid, 3); // col 3 = Session ID
  if (!row) {
    var newRow = new Array(23).fill('');
    newRow[0]  = now;           // Date
    newRow[1]  = data.user_id || '';
    newRow[2]  = sid;           // Session ID
    newRow[11] = 'No';          // Paywall Seen default
    newRow[14] = 0;             // Deep Dive Qs
    newRow[15] = 0;             // Free Text Count
    sheet.appendRow(newRow);
    row = sheet.getLastRow();
  }

  var stage = data.stage || '';

  // Always update these
  sheet.getRange(row, 1).setValue(now);   // Date
  sheet.getRange(row, 21).setValue(now);  // Updated At
  if (stage) sheet.getRange(row, 20).setValue(stage); // Last Stage
  if (data.duration_s) sheet.getRange(row, 19).setValue(data.duration_s);

  // Update fields only when provided
  if (data.user_id)              sheet.getRange(row, 2).setValue(data.user_id);
  if (data.previous_session_id)  sheet.getRange(row, 4).setValue(data.previous_session_id);
  if (data.role)                 sheet.getRange(row, 5).setValue(data.role);
  if (data.seniority)            sheet.getRange(row, 6).setValue(data.seniority);
  if (data.template || data.initial_range)
                                 sheet.getRange(row, 7).setValue(data.template || data.initial_range);
  if (data.mode || data.final_range)
                                 sheet.getRange(row, 8).setValue(data.mode || data.final_range);
  if (data.download_pdf)         sheet.getRange(row, 9).setValue('Yes');
  if (data.blocker_code || data.obstacle_code)
                                 sheet.getRange(row, 10).setValue(data.blocker_code || data.obstacle_code);
  if (data.blocker_label)        sheet.getRange(row, 11).setValue(data.blocker_label);
  if (stage === 'paywall' || data.paywall_seen)
                                 sheet.getRange(row, 12).setValue('Yes');
  if (data.paywall_action)       sheet.getRange(row, 13).setValue(data.paywall_action);
  if (data.deep_dive_gaps)       sheet.getRange(row, 14).setValue(data.deep_dive_gaps);
  if (data.deep_dive_qs !== undefined) sheet.getRange(row, 15).setValue(data.deep_dive_qs);
  if (data.free_text_count !== undefined) sheet.getRange(row, 16).setValue(data.free_text_count);
  if (data.landing_ref)          sheet.getRange(row, 17).setValue(data.landing_ref);
  if (data.source)               sheet.getRange(row, 18).setValue(data.source);
  if (data.video_watched)        sheet.getRange(row, 22).setValue(data.video_watched);
  if (data.video_completed)      sheet.getRange(row, 23).setValue(data.video_completed);

  // Row color by stage
  colorRaiseRow(sheet, row, stage, data.paywall_action, data.mode);
  return jsonOk();
}

function colorRaiseRow(sheet, row, stage, paywallAction, mode) {
  var range = sheet.getRange(row, 1, 1, 23);
  if (paywallAction === 'paid') {
    range.setBackground('#fff8e6');
    sheet.getRange(row, 13).setFontWeight('bold').setFontColor('#b8860b');
  } else if (paywallAction === 'checkout_started') { range.setBackground('#fff3e0');
  } else if (stage === 'pdf_download')              { range.setBackground('#e6ffe6');
  } else if (stage === 'paywall')                   { range.setBackground('#fff0f0');
  } else if (stage === 'case_paywall_shown')        { range.setBackground('#f0e6ff');
  } else if (stage === 'sim_opening_picked' || stage === 'sim_reply_tapped') { range.setBackground('#f0f0ff');
  } else if (stage === 'chips_seen')                { range.setBackground('#f5f0ff');
  } else                                            { range.setBackground('#f0f8ff');
  }
}

function formatRaiseHeaders(sheet) {
  var h = ['Date','User ID','Session ID','Prev Session ID','Role','Seniority',
           'Template','Mode','Download PDF','Blocker Code','Blocker Label',
           'Paywall Seen','Paywall Action','Deep Dive Gaps','Deep Dive Qs',
           'Free Text Count','Landing Ref','Source','Duration (s)',
           'Last Stage','Updated At','Video Watched','Video Completed'];
  sheet.getRange(1, 1, 1, h.length).setValues([h]);
  sheet.getRange(1, 1, 1, h.length)
    .setBackground('#07090f').setFontColor('#c9a84c')
    .setFontWeight('bold').setFontSize(11).setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  [130,140,200,160,200,100,140,100,90,120,280,90,130,160,90,110,160,240,90,120,130,120,120]
    .forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });
}

// ═══════════════════════════════════════════════════════════════
// OFFER SESSIONS — one row per session_id
// Columns (26): Date | User ID | Session ID | Role | Base Salary |
//   City | Employment | Competing | Risk | Work Type | Experience |
//   Anchor | Company Size | Speed | Deadline | Paywall Seen |
//   Paywall Action | Download PDF | Source | Duration (s) |
//   Last Stage | Updated At | Research Max | Posted Max | Extras | Industry
// ═══════════════════════════════════════════════════════════════

// Column map for offer sheet (1-based)
var OFFER_COLS = {
  role:4, base:5, city:6, employment:7, competing:8, risk:9,
  worktype:10, experience:11, anchor:12, company_size:13,
  speed:14, deadline:15,
  research:23, posted_max:24, extras:25, industry:26   // NEW — appended, not inserted, so existing rows stay aligned
};

// Question ID → column (for per-question live updates)
var Q_TO_COL = {
  risk:'risk', employment:'employment', competing:'competing',
  worktype:'worktype', experience:'experience', anchor:'anchor',
  company_size:'company_size', role:'role', base:'base', city:'city',
  speed:'speed', deadline:'deadline',
  research:'research', posted_max:'posted_max', extras:'extras', industry:'industry'   // NEW
};

function handleOfferSession(data, ss, now) {
  var sheet = ss.getSheetByName('Offer Sessions');
  if (!sheet) {
    sheet = ss.insertSheet('Offer Sessions');
    formatOfferHeaders(sheet);
  }

  var sid = data.session_id || '';
  if (!sid) return jsonOk();

  // Find or create row
  var row = findRow(sheet, sid, 3);
  if (!row) {
    var newRow = new Array(26).fill(''); // was 22 — extended for research/posted_max/extras/industry
    newRow[0]  = now;
    newRow[1]  = data.user_id || '';
    newRow[2]  = sid;
    newRow[15] = 'No'; // Paywall Seen default (col 16, 0-based index 15)
    sheet.appendRow(newRow);
    row = sheet.getLastRow();
  }

  var stage = data.stage || '';

  // Always update timestamps
  sheet.getRange(row, 1).setValue(now);
  sheet.getRange(row, 22).setValue(now);
  if (data.duration_s) sheet.getRange(row, 20).setValue(data.duration_s);
  if (stage) sheet.getRange(row, 21).setValue(stage);
  if (data.user_id) sheet.getRange(row, 2).setValue(data.user_id);
  if (data.source)  sheet.getRange(row, 19).setValue(data.source);

  // ── Per-question live update ──
  // Writes the answer to the right column immediately after each question
  if (stage.startsWith('offer_q_') && data.last_question && data.answer) {
    var qid = data.last_question;
    var fieldName = Q_TO_COL[qid];
    if (fieldName && OFFER_COLS[fieldName]) {
      sheet.getRange(row, OFFER_COLS[fieldName]).setValue(data.answer);
    }
    return jsonOk();
  }

  // ── offer_complete: write all context fields directly ──
  if (stage === 'offer_complete') {
    if (data.role)         sheet.getRange(row, 4).setValue(data.role);
    if (data.base)         sheet.getRange(row, 5).setValue(data.base);
    if (data.city)         sheet.getRange(row, 6).setValue(data.city);
    if (data.employment)   sheet.getRange(row, 7).setValue(data.employment);
    if (data.competing)    sheet.getRange(row, 8).setValue(data.competing);
    if (data.risk)         sheet.getRange(row, 9).setValue(data.risk);
    if (data.worktype)     sheet.getRange(row, 10).setValue(data.worktype);
    if (data.experience)   sheet.getRange(row, 11).setValue(data.experience);
    if (data.anchor)       sheet.getRange(row, 12).setValue(data.anchor);
    if (data.company_size) sheet.getRange(row, 13).setValue(data.company_size);
    if (data.speed)        sheet.getRange(row, 14).setValue(data.speed);
    if (data.deadline)     sheet.getRange(row, 15).setValue(data.deadline);
    if (data.research)     sheet.getRange(row, 23).setValue(data.research);     // NEW
    if (data.posted_max)   sheet.getRange(row, 24).setValue(data.posted_max);   // NEW
    if (data.extras)       sheet.getRange(row, 25).setValue(data.extras);       // NEW
    if (data.industry)     sheet.getRange(row, 26).setValue(data.industry);     // NEW — client already sends this, was never read
    sheet.getRange(row, 1, 1, 26).setBackground('#f0fff4');
    return jsonOk();
  }

  // ── offer_paywall: Paywall Seen = Yes ──
  if (stage === 'offer_paywall' || data.paywall_seen === 'Yes') {
    sheet.getRange(row, 16).setValue('Yes');
    if (data.role)       sheet.getRange(row, 4).setValue(data.role);
    if (data.employment) sheet.getRange(row, 7).setValue(data.employment);
    if (data.competing)  sheet.getRange(row, 8).setValue(data.competing);
    if (data.risk)       sheet.getRange(row, 9).setValue(data.risk);
    sheet.getRange(row, 1, 1, 26).setBackground('#fff0f0');
    return jsonOk();
  }

  // ── checkout / payment ──
  if (data.paywall_action) {
    sheet.getRange(row, 17).setValue(data.paywall_action);
    if (data.paywall_action === 'paid') {
      sheet.getRange(row, 1, 1, 26).setBackground('#fff8e6');
      sheet.getRange(row, 17).setFontWeight('bold').setFontColor('#b8860b');
    } else if (data.paywall_action === 'checkout_started') {
      sheet.getRange(row, 1, 1, 26).setBackground('#fff3e0');
    }
  }

  if (data.download_pdf) sheet.getRange(row, 18).setValue('Yes');

  // ── offer_dropped ──
  if (stage === 'offer_dropped' && data.last_question) {
    sheet.getRange(row, 19).setValue('dropped @ ' + data.last_question + ' (' + (data.questions_answered || 0) + '/15)');
    sheet.getRange(row, 1, 1, 26).setBackground('#ffe8e8');
  }

  return jsonOk();
}

function formatOfferHeaders(sheet) {
  var h = ['Date','User ID','Session ID','Role','Base Salary','City',
           'Employment','Competing','Risk','Work Type','Experience',
           'Anchor','Company Size','Speed','Deadline','Paywall Seen','Paywall Action',
           'Download PDF','Source','Duration (s)','Last Stage','Updated At',
           'Research Max','Posted Max','Extras','Industry'];   // NEW — 4 appended
  sheet.getRange(1, 1, 1, h.length).setValues([h]);
  sheet.getRange(1, 1, 1, h.length)
    .setBackground('#1a0f3a').setFontColor('#c9a84c')
    .setFontWeight('bold').setFontSize(11).setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  [130,140,200,180,100,120,140,100,90,100,100,90,110,90,90,100,130,90,240,90,120,130,110,110,140,140]
    .forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });
}

// ═══════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════

function findRow(sheet, id, colNum) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var vals = sheet.getRange(2, colNum, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) return i + 2;
  }
  return null;
}

function jsonOk() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
// LEADS, WAITLIST, COURSES
// ═══════════════════════════════════════════════════════════════

function handleWaitlist(data, ss, now) {
  var sheet = ss.getSheetByName('Waitlist') || ss.insertSheet('Waitlist');
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,5).setValues([['Date','Event','Email','Role','Source']]);
    sheet.getRange(1,1,1,5).setBackground('#07090f').setFontColor('#c9a84c').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([now, data.event||'', data.email||'', data.role||'', data.source||'']);
  sheet.getRange(sheet.getLastRow(),1,1,5)
    .setBackground(data.event === 'WAITLIST_NOTIFY' ? '#f0f8ff' : '#f5f0ff');
  return jsonOk();
}

function handleLead(data, ss, now) {
  var sheet = ss.getSheetByName('Leads') || ss.getActiveSheet();
  sheet.appendRow([
    now, data.event||'', data.email||'', data.title||'', data.experience||'',
    data.seniority||'', data.sector||'', data.skills||'',
    data.riskScore||data.score||'', data.verdict||'',
    data.usedCoach ? 'Yes' : '',
    data.event==='CHECKOUT_STARTED' ? 'Yes' : (data.event==='PAID' ? 'Completed' : ''),
    data.amountPaid||'', data.stripeSession||'',
    data.cacheHit !== undefined ? (data.cacheHit ? 'Yes' : 'No') : '',
    data.refCode||'', data.refSource||'', data.source||'',
    data.timestamp || new Date().toISOString()
  ]);
  var lr = sheet.getLastRow();
  sheet.getRange(lr,1,1,19).setBackground(
    data.event==='PAID' ? '#fff8e6' :
    data.event==='CHECKOUT_STARTED' ? '#fff3e0' :
    data.event==='COACH_SESSION' ? '#f0fff4' : '#f0f8ff'
  );
  if (data.event==='PAID') sheet.getRange(lr,2).setFontWeight('bold').setFontColor('#b8860b');
  return jsonOk();
}

function getCourses() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Courses');
    if (!sheet) return ContentService.createTextOutput(JSON.stringify({courses:[]})).setMimeType(ContentService.MimeType.JSON);
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return ContentService.createTextOutput(JSON.stringify({courses:[]})).setMimeType(ContentService.MimeType.JSON);
    var headers = data[0].map(function(h){ return h.toString().toLowerCase().replace(/\s+/g,''); });
    var courses = [];
    for (var i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      var c = {};
      headers.forEach(function(h,idx){ c[h] = data[i][idx] ? data[i][idx].toString() : ''; });
      courses.push(c);
    }
    return ContentService.createTextOutput(JSON.stringify({courses:courses})).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    return ContentService.createTextOutput(JSON.stringify({error:e.toString(),courses:[]})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
// SETUP & TESTS — run these manually from Apps Script
// ═══════════════════════════════════════════════════════════════

function setupAllTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rs = ss.getSheetByName('Raise Sessions') || ss.insertSheet('Raise Sessions');
  formatRaiseHeaders(rs);
  var os = ss.getSheetByName('Offer Sessions') || ss.insertSheet('Offer Sessions');
  formatOfferHeaders(os);
  Logger.log('✓ Raise Sessions + Offer Sessions ready');
}

function testRaiseLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var sid = 'TEST_RAISE_' + new Date().getTime();
  // Simulate sim_start
  handleRaiseSession({ event:'RAISE_SESSION', product:'raise', stage:'sim_start',
    session_id:sid, user_id:'u_test', blocker_code:'no_script',
    blocker_label:'Test blocker', mode:'plan', landing_ref:'test',
    source:'test', duration_s:5 }, ss, now);
  // Simulate context_added role
  handleRaiseSession({ event:'RAISE_SESSION', product:'raise', stage:'context_added',
    session_id:sid, role:'Senior Product Manager', key:'role',
    value:'Senior Product Manager', duration_s:30 }, ss, now);
  // Simulate paywall
  handleRaiseSession({ event:'RAISE_SESSION', product:'raise', stage:'paywall',
    session_id:sid, paywall_seen:true, duration_s:90 }, ss, now);
  Logger.log('✓ testRaiseLog done — check Raise Sessions for ' + sid);
}

function testOfferLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var sid = 'TEST_OFFER_' + new Date().getTime();
  // disc_start
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'disc_start',
    session_id:sid, user_id:'u_test', source:'test', duration_s:1 }, ss, now);
  // per-question progress
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'offer_q_risk',
    session_id:sid, last_question:'risk', questions_answered:1, duration_s:10 }, ss, now);
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'offer_q_research',
    session_id:sid, last_question:'research', answer:'110,000', questions_answered:12, duration_s:45 }, ss, now);
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'offer_q_posted_max',
    session_id:sid, last_question:'posted_max', answer:'120,000', questions_answered:13, duration_s:50 }, ss, now);
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'offer_q_extras',
    session_id:sid, last_question:'extras', answer:'signing', questions_answered:14, duration_s:55 }, ss, now);
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'offer_q_deadline',
    session_id:sid, last_question:'deadline', questions_answered:7, duration_s:60 }, ss, now);
  // offer_complete
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'offer_complete',
    session_id:sid, role:'Product Manager', industry:'Fintech',
    blocker_label:'employed_stable | yes | balanced | $95000 | Calgary | no_anchor | remote | 5_10 | growing',
    duration_s:120 }, ss, now);
  // paywall
  handleOfferSession({ event:'RAISE_SESSION', product:'offer', stage:'offer_paywall',
    session_id:sid, paywall_seen:'Yes', duration_s:150 }, ss, now);
  Logger.log('✓ testOfferLog done — check Offer Sessions for ' + sid + ' (verify Research/Posted Max/Extras/Industry columns filled)');
}
