// ══════════════════════════════════════════════════════════════
//  Campbell Research Portal — Multi‑Study API Server
//  Deploy on Render. Database: Supabase PostgreSQL.
//  Environment variables:
//    SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_PIN, PORT
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
function isAdminAuthorised(req) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  return pin === ADMIN_PIN;
}
function generateParticipantCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'AL-' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date() }));

// ══════════════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS (no auth)
// ══════════════════════════════════════════════════════════════

// List all open studies (for participant selection)
app.get('/api/studies', async (req, res) => {
  const { data, error } = await sb
    .from('studies')
    .select('id, study_key, title_en, title_ha, description_en, description_ha, status, capacity')
    .eq('status', 'open')
    .order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get full configuration for a specific study (puzzles, assessments, etc.)
app.get('/api/studies/:id/config', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await sb
    .from('studies')
    .select('config')
    .eq('id', id)
    .single();
  if (error) return res.status(404).json({ error: 'Study not found' });
  res.json(data.config || {});
});

// Register or retrieve participant and enrol in a study
app.post('/api/enrol', async (req, res) => {
  const { name, matric, lang, studyId, demographics, consentGeneral } = req.body;
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
    // Optionally update demographics and consent
    if (demographics || consentGeneral !== undefined) {
      const updates = {};
      if (demographics) updates.demographics = demographics;
      if (consentGeneral !== undefined) updates.consent_general = consentGeneral;
      if (lang) updates.lang = lang;
      await sb.from('participants').update(updates).eq('id', participant.id);
    }
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
        consent_general: consentGeneral || false
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    participant = newPart;
  }

  // 2. Check study capacity & status
  const { data: study } = await sb
    .from('studies')
    .select('status, capacity')
    .eq('id', studyId)
    .single();
  if (!study) return res.status(404).json({ error: 'Study not found' });
  if (study.status !== 'open') {
    return res.status(403).json({ error: 'Study is not open for enrolment' });
  }
  const { count: enrolled } = await sb
    .from('enrolments')
    .select('*', { count: 'exact', head: true })
    .eq('study_id', studyId);
  if (enrolled >= study.capacity) {
    return res.status(403).json({ error: 'Study has reached capacity' });
  }

  // 3. Create enrolment if not exists
  let enrolment;
  const { data: existingEnrol } = await sb
    .from('enrolments')
    .select('*')
    .eq('participant_id', participant.id)
    .eq('study_id', studyId)
    .maybeSingle();

  if (existingEnrol) {
    enrolment = existingEnrol;
  } else {
    const { data: newEnrol, error } = await sb
      .from('enrolments')
      .insert({
        participant_id: participant.id,
        study_id: studyId,
        status: 'enrolled',
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
    participantId: participant.id
  });
});

// Get all enrolments for a participant (using participant_code)
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

// Load progress for a specific enrolment
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

// Save progress for an enrolment
app.post('/api/progress/:enrolmentId', async (req, res) => {
  const { enrolmentId } = req.params;
  const progressData = req.body;
  const updates = {
    data: progressData,
    last_active: new Date(),
    status: progressData.completed ? 'completed' : 'in_progress'
  };
  if (progressData.completedAt) {
    updates.completed_at = new Date(progressData.completedAt);
    updates.duration_ms = progressData.durationMs;
  }
  const { error } = await sb
    .from('enrolments')
    .update(updates)
    .eq('id', enrolmentId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ saved: true });
});

// ══════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS (require ADMIN_PIN)
// ══════════════════════════════════════════════════════════════

// Get all studies (admin)
app.get('/api/admin/studies', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { data, error } = await sb.from('studies').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Update study (status, capacity, config, etc.)
app.post('/api/admin/studies/:id', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { id } = req.params;
  const updates = req.body;
  updates.updated_at = new Date();
  const { error } = await sb.from('studies').update(updates).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated: true });
});

// Get all enrolments (optionally filtered by study)
app.get('/api/admin/enrolments', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { studyId } = req.query;
  let query = sb.from('enrolments').select(`*, participant:participant_id (name, matric, participant_code, demographics, lang), study:study_id (*)`);
  if (studyId) query = query.eq('study_id', studyId);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Export enrolments for a study as CSV
app.get('/api/admin/export/study/:studyId', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { studyId } = req.params;
  const { data, error } = await sb
    .from('enrolments')
    .select(`*, participant:participant_id (name, matric, participant_code, demographics, lang)`)
    .eq('study_id', studyId);
  if (error) return res.status(500).json({ error: error.message });

  // Flatten to CSV
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

// ── Portal status (study‑agnostic, returns counts for all studies) ──
app.get('/api/admin/status', async (req, res) => {
  if (!isAdminAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });
  const { data: studies } = await sb.from('studies').select('id, status, capacity');
  const summary = await Promise.all(studies.map(async (study) => {
    const { count: enrolled } = await sb.from('enrolments').select('*', { count: 'exact', head: true }).eq('study_id', study.id);
    const { count: completed } = await sb.from('enrolments').select('*', { count: 'exact', head: true }).eq('study_id', study.id).eq('status', 'completed');
    return { ...study, enrolled, completed };
  }));
  res.json(summary);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Multi‑study Research portal API running on port ${PORT}`));