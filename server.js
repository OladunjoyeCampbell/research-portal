// ══════════════════════════════════════════════════════════════
//  Research Portal API – Full feature implementation
//  Deploy on Render. Database: Supabase PostgreSQL.
//  Environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_PIN, PORT
// ══════════════════════════════════════════════════════════════

'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// ── Supabase client ────────────────────────────────────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  process.exit(1);
}
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// Helper functions
function generateParticipantCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'AL-' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function assignRandomisationGroup() {
  return Math.random() < 0.5 ? 'treatment' : 'control';
}

function computeMissingDataFlags(progress, studyConfig) {
  const flags = {
    incomplete_survey: false,
    attention_failed: false,
    too_fast: false,
    missing_puzzles: false,
    survey_missing_fields: []
  };
  // Survey completeness
  const survey = progress.surveyAnswers || {};
  const totalSurvey = (studyConfig?.surveyFields || []).length;
  if (totalSurvey > 0 && Object.keys(survey).length < totalSurvey) {
    flags.incomplete_survey = true;
    flags.survey_missing_fields = Object.keys(studyConfig.surveyFields).filter(f => !survey[f.id]);
  }
  // Attention checks
  if (progress.preAttentionPassed === false || progress.postAttentionPassed === false) flags.attention_failed = true;
  // Duration under 15 minutes
  const durationMs = progress.durationMs || (progress.completedAt ? (new Date(progress.completedAt) - new Date(progress.startedAt)) : 0);
  if (durationMs < 15 * 60 * 1000) flags.too_fast = true;
  // Puzzles completion
  const puzzles = progress.puzzles || {};
  const totalPuzzles = (studyConfig?.puzzles || []).length;
  const completedPuzzles = Object.values(puzzles).filter(p => p.completed).length;
  if (completedPuzzles < totalPuzzles) flags.missing_puzzles = true;
  return flags;
}

async function logAdminAction(req, action, targetType, targetId, details) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  await sb.from('admin_audit_log').insert({
    admin_pin: pin,
    action,
    target_type: targetType,
    target_id: String(targetId),
    details: details || {},
    ip_address: ip
  });
}

function isAdminAuthorised(req) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  return pin === ADMIN_PIN;
}

// ── Health ──
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date() }));

// ══════════════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS
// ══════════════════════════════════════════════════════════════

// List open studies (not expired)
app.get('/api/studies', async (req, res) => {
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from('studies')
    .select('id, study_key, title_en, title_ha, description_en, description_ha, status, capacity')
    .eq('status', 'open')
    .or(`end_date.is.null,end_date.gt.${now}`)
    .order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get study config
app.get('/api/studies/:id/config', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await sb
    .from('studies')
    .select('config, instruments, delayed_post_test_weeks')
    .eq('id', id)
    .single();
  if (error) return res.status(404).json({ error: 'Study not found' });
  res.json({ ...data.config, instruments: data.instruments, delayed_post_test_weeks: data.delayed_post_test_weeks });
});

// Enrol or retrieve participant + enrolment
app.post('/api/enrol', async (req, res) => {
  const { name, matric, lang, studyId, demographics, consentGeneral, academicSession, classSection, lecturerId } = req.body;
  if (!name || !matric || !studyId) {
    return res.status(400).json({ error: 'name, matric, studyId required' });
  }

  // 1. Find or create participant
  let participant;
  const { data: existing } = await sb
    .from('participants')
    .select('*')
    .ilike('matric', matric.trim().toUpperCase())
    .maybeSingle();

  if (existing) {
    participant = existing;
    const updates = {};
    if (demographics) updates.demographics = demographics;
    if (consentGeneral !== undefined) updates.consent_general = consentGeneral;
    if (lang) updates.lang = lang;
    if (academicSession) updates.academic_session = academicSession;
    if (classSection) updates.class_section = classSection;
    if (lecturerId) updates.lecturer_id = lecturerId;
    if (Object.keys(updates).length) await sb.from('participants').update(updates).eq('id', participant.id);
  } else {
    const code = generateParticipantCode();
    const { data: newPart, error } = await sb
      .from('participants')
      .insert({
        participant_code: code,
        name: name.trim(),
        matric: matric.trim().toUpperCase(),
        lang: lang || 'en',
        demographics: demographics || {},
        consent_general: consentGeneral || false,
        academic_session: academicSession,
        class_section: classSection,
        lecturer_id: lecturerId
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    participant = newPart;
  }

  // 2. Check study availability
  const { data: study } = await sb
    .from('studies')
    .select('status, capacity, end_date, delayed_post_test_weeks, config')
    .eq('id', studyId)
    .single();
  if (!study) return res.status(404).json({ error: 'Study not found' });
  if (study.status !== 'open') return res.status(403).json({ error: 'Study is not open for enrolment' });
  if (study.end_date && new Date(study.end_date) < new Date()) {
    return res.status(403).json({ error: 'Study enrolment period has expired' });
  }
  const { count: enrolled } = await sb
    .from('enrolments')
    .select('*', { count: 'exact', head: true })
    .eq('study_id', studyId);
  if (enrolled >= study.capacity) return res.status(403).json({ error: 'Study has reached capacity' });

  // 3. Enrol or resume
  let enrolment;
  const { data: existingEnrol } = await sb
    .from('enrolments')
    .select('*')
    .eq('participant_id', participant.id)
    .eq('study_id', studyId)
    .maybeSingle();

  if (existingEnrol) {
    enrolment = existingEnrol;
    // If enrolment is withdrawn, do not allow re-enrolment
    if (enrolment.status === 'withdrawn') {
      return res.status(403).json({ error: 'You have withdrawn from this study and cannot rejoin' });
    }
  } else {
    const randomGroup = assignRandomisationGroup();
    const instrumentVersion = study.config?.version || '1.0.0';
    const { data: newEnrol, error } = await sb
      .from('enrolments')
      .insert({
        participant_id: participant.id,
        study_id: studyId,
        status: 'enrolled',
        randomisation_group: randomGroup,
        instrument_version: instrumentVersion,
        data: {}
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    enrolment = newEnrol;
  }

  res.json({
    participantCode: participant.participant_code,
    enrolmentId: enrolment.id,
    studyId,
    isNew: !existingEnrol,
    randomisationGroup: enrolment.randomisation_group,
    participantId: participant.id
  });
});

// Get all enrolments for participant
app.get('/api/enrolments/me', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'participant_code required' });
  const { data: participant } = await sb
    .from('participants')
    .select('id')
    .eq('participant_code', code)
    .single();
  if (!participant) return res.status(404).json({ error: 'Participant not found' });
  const { data, error } = await sb
    .from('enrolments')
    .select(`*, study:study_id (id, study_key, title_en, title_ha, status)`)
    .eq('participant_id', participant.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Load progress for enrolment
app.get('/api/progress/:enrolmentId', async (req, res) => {
  const { enrolmentId } = req.params;
  const { data, error } = await sb
    .from('enrolments')
    .select('data, status, study_id')
    .eq('id', enrolmentId)
    .single();
  if (error) return res.status(404).json({ error: 'Enrolment not found' });
  res.json({ progress: data.data || {}, status: data.status, studyId: data.study_id });
});

// Save progress (with data lock, missing flags, status updates)
app.post('/api/progress/:enrolmentId', async (req, res) => {
  const { enrolmentId } = req.params;
  const progressData = req.body;

  // Fetch enrolment with study details
  const { data: enrolment, error } = await sb
    .from('enrolments')
    .select('*, study:study_id(*)')
    .eq('id', enrolmentId)
    .single();
  if (error) return res.status(404).json({ error: 'Enrolment not found' });
  const study = enrolment.study;

  // Data lock: if study is closed and enrolment not withdrawn, reject
  if (study.status !== 'open' && enrolment.status !== 'withdrawn') {
    return res.status(403).json({ error: 'Study is closed – no further progress accepted' });
  }
  if (enrolment.status === 'withdrawn') {
    return res.status(403).json({ error: 'Participant has withdrawn' });
  }

  let newStatus = enrolment.status;
  if (progressData.completed) {
    newStatus = 'completed';
    // Compute missing data flags
    const flags = computeMissingDataFlags(progressData, study.config);
    progressData.missingDataFlags = flags;
    progressData.completedAt = new Date().toISOString();
    progressData.durationMs = (new Date() - new Date(enrolment.started_at));
  } else if (newStatus === 'enrolled' && Object.keys(progressData).length > 2) {
    newStatus = 'in_progress';
  }

  const updates = {
    data: progressData,
    last_active: new Date(),
    status: newStatus
  };
  if (progressData.completedAt) {
    updates.completed_at = new Date(progressData.completedAt);
    updates.duration_ms = progressData.durationMs;
  }
  if (progressData.missingDataFlags) updates.missing_data_flags = progressData.missingDataFlags;

  const { error: updateErr } = await sb.from('enrolments').update(updates).eq('id', enrolmentId);
  if (updateErr) return res.status(500).json({ error: updateErr.message });
  res.json({ saved: true });
});

// Withdraw from study
app.post('/api/enrolment/:enrolmentId/withdraw', async (req, res) => {
  const { enrolmentId } = req.params;
  const { data: enrolment, error } = await sb
    .from('enrolments')
    .select('*')
    .eq('id', enrolmentId)
    .single();
  if (error) return res.status(404).json({ error: 'Enrolment not found' });
  if (enrolment.status === 'completed' || enrolment.status === 'withdrawn') {
    return res.status(400).json({ error: 'Cannot withdraw completed or already withdrawn enrolment' });
  }
  const { error: updateErr } = await sb
    .from('enrolments')
    .update({ status: 'withdrawn', withdrawn_at: new Date(), data: {} })
    .eq('id', enrolmentId);
  if (updateErr) return res.status(500).json({ error: 'Withdrawal failed' });
  res.json({ success: true });
});

// Get average gain for a study (peer comparison)
app.get('/api/study/:studyId/average_gain', async (req, res) => {
  const { studyId } = req.params;
  const { data, error } = await sb
    .from('enrolments')
    .select('data')
    .eq('study_id', studyId)
    .eq('status', 'completed');
  if (error) return res.status(500).json({ error });
  let gains = [];
  data.forEach(e => {
    const pre = e.data?.preScore;
    const post = e.data?.postScore;
    if (typeof pre === 'number' && typeof post === 'number') gains.push(post - pre);
  });
  const avg = gains.length ? gains.reduce((a,b)=>a+b,0)/gains.length : 0;
  res.json({ averageGain: avg, participantCount: gains.length });
});

// Lecturer dashboard (read‑only, filtered by lecturer_id)
app.get('/api/lecturer/:lecturerId/enrolments', async (req, res) => {
  const { lecturerId } = req.params;
  // Simple auth: require a lecturer PIN? For simplicity, we use a separate header or query.
  // We'll use a simple query parameter "token" that must match a preset value.
  const token = req.query.token;
  if (!token || token !== process.env.LECTURER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const { data, error } = await sb
    .from('participants')
    .select('name, matric, class_section, academic_session, enrolments!inner(id, status, completed_at, randomisation_group, missing_data_flags)')
    .eq('lecturer_id', lecturerId);
  if (error) return res.status(500).json({ error });
  // Remove individual scores, only show completion status
  res.json(data);
});

// ══════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS (require ADMIN_PIN)
// ══════════════════════════════════════════════════════════════

// Get all studies
app.get('/api/admin/studies', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { data, error } = await sb.from('studies').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Update study
app.post('/api/admin/studies/:id', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { id } = req.params;
  const updates = req.body;
  updates.updated_at = new Date();
  const { error } = await sb.from('studies').update(updates).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  await logAdminAction(req, 'update_study', 'study', id, updates);
  res.json({ updated: true });
});

// Portal control (status, capacity)
app.post('/api/admin/control', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { study_id, status, capacity } = req.body;
  if (!study_id) return res.status(400).json({ error: 'study_id required' });
  const updates = {};
  if (status) updates.status = status;
  if (capacity) updates.capacity = capacity;
  const { error } = await sb.from('studies').update(updates).eq('id', study_id);
  if (error) return res.status(500).json({ error: error.message });
  await logAdminAction(req, 'portal_control', 'study', study_id, { status, capacity });
  res.json({ updated: true });
});

// Get portal status for a study
app.get('/api/admin/status', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const studyId = req.query.study;
  if (!studyId) return res.status(400).json({ error: 'study query param required' });
  const { data: study } = await sb.from('studies').select('status, capacity, end_date').eq('id', studyId).single();
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const { count: enrolled } = await sb.from('enrolments').select('*', { count: 'exact', head: true }).eq('study_id', studyId);
  const { count: completed } = await sb.from('enrolments').select('*', { count: 'exact', head: true }).eq('study_id', studyId).eq('status', 'completed');
  const { count: inProgress } = await sb.from('enrolments').select('*', { count: 'exact', head: true }).eq('study_id', studyId).eq('status', 'in_progress');
  res.json({ status: study.status, capacity: study.capacity, end_date: study.end_date, enrolled, completed, inProgress });
});

// Export enrolments for a study as CSV
app.get('/api/admin/export/study/:studyId', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { studyId } = req.params;
  const { data, error } = await sb
    .from('enrolments')
    .select(`*, participant:participant_id (name, matric, participant_code, demographics, lang, academic_session, class_section, lecturer_id)`)
    .eq('study_id', studyId);
  if (error) return res.status(500).json({ error: error.message });

  const flatten = (obj, prefix = '') => {
    let result = {};
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        const newKey = prefix ? `${prefix}_${key}` : key;
        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
          Object.assign(result, flatten(obj[key], newKey));
        } else {
          result[newKey] = obj[key];
        }
      }
    }
    return result;
  };

  const rows = data.map(enrol => flatten({ enrolment, participant: enrol.participant }));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const csvRows = [
    headers.join(','),
    ...rows.map(row => headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','))
  ];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="study_${studyId}_export.csv"`);
  res.send(csvRows.join('\n'));
});

// Export for open science (AJOL / Zenodo compatible JSON)
app.get('/api/admin/export/open-science/:studyId', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { studyId } = req.params;
  const { data, error } = await sb
    .from('enrolments')
    .select(`id, randomisation_group, instrument_version, status, missing_data_flags, started_at, completed_at, duration_ms,
             participant:participant_id (name, matric, academic_session, class_section)`)
    .eq('study_id', studyId);
  if (error) return res.status(500).json({ error: error.message });
  // Remove direct identifiers for open science
  const anonymised = data.map(e => ({
    ...e,
    participant: { academic_session: e.participant.academic_session, class_section: e.participant.class_section },
    pre_score: e.data?.preScore,
    post_score: e.data?.postScore,
    gain: e.data?.postScore - e.data?.preScore,
    missing_flags: e.missing_data_flags
  }));
  res.json({ study_id: studyId, exported_at: new Date(), data: anonymised });
});

// Admin audit log
app.get('/api/admin/audit-log', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { data, error } = await sb.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Reminders queue (admin only) – manual trigger
app.post('/api/admin/reminders/trigger', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  // This would be called by a cron job; we'll just insert pending reminders based on inactive enrolments
  const { studyId } = req.body;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3); // 3 days
  const { data: inactive, error } = await sb
    .from('enrolments')
    .select('id, participant:participant_id(name, matric, phone), last_active')
    .eq('study_id', studyId)
    .in('status', ['enrolled', 'in_progress'])
    .lt('last_active', cutoff.toISOString())
    .lt('reminder_count', 3);
  if (error) return res.status(500).json({ error });
  for (const e of inactive) {
    const phone = e.participant?.phone; // you need a phone column in participants
    if (!phone) continue;
    await sb.from('reminders_queue').insert({
      enrolment_id: e.id,
      type: 'whatsapp',
      recipient: phone,
      message: `Hello ${e.participant.name}, you have not completed your study in the Research Portal. Please resume using your participant code.`,
      scheduled_for: new Date(),
      status: 'pending'
    });
    await sb.from('enrolments').update({ reminder_count: e.reminder_count + 1, last_reminder_sent: new Date() }).eq('id', e.id);
  }
  res.json({ reminders_queued: inactive.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Research Portal API running on port ${PORT}`));