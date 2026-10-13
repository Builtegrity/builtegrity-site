export async function runComplianceMonitor(env) {
  if (!env.DB) throw new Error('Compliance monitor requires D1 binding DB');
  const rows = await env.DB.prepare(`
    SELECT item_key,item_type,subject_id,severity,summary,due_at,state
      FROM compliance_due_queue
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'ERROR' THEN 2 WHEN 'WARN' THEN 3 ELSE 4 END,
              due_at IS NULL, due_at
     LIMIT 1000
  `).all();

  const current = new Set();
  for (const item of rows.results || []) {
    const alertKey = `compliance:${item.item_key}`;
    current.add(alertKey);
    const message = `${item.summary}${item.due_at ? `; due/review ${item.due_at}` : ''}; state=${item.state}`.slice(0,2000);
    await env.DB.prepare(`
      INSERT INTO system_alerts(alert_key,category,severity,status,subject_type,subject_id,message)
      VALUES(?, 'COMPLIANCE', ?, 'OPEN', ?, ?, ?)
      ON CONFLICT(alert_key) DO UPDATE SET
        category='COMPLIANCE',severity=excluded.severity,status='OPEN',subject_type=excluded.subject_type,
        subject_id=excluded.subject_id,message=excluded.message,last_seen_at=CURRENT_TIMESTAMP,
        resolved_at=NULL,occurrences=system_alerts.occurrences+1
    `).bind(alertKey,normalizeSeverity(item.severity),item.item_type,item.subject_id,message).run();
  }

  const open = await env.DB.prepare(`
    SELECT alert_key FROM system_alerts WHERE category='COMPLIANCE' AND status='OPEN'
  `).all();
  let resolved=0;
  for (const alert of open.results || []) {
    if (!current.has(alert.alert_key)) {
      await env.DB.prepare(`
        UPDATE system_alerts SET status='RESOLVED',resolved_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP
         WHERE alert_key=? AND status='OPEN'
      `).bind(alert.alert_key).run();
      resolved+=1;
    }
  }

  const counts={INFO:0,WARN:0,ERROR:0,CRITICAL:0};
  for(const row of rows.results||[]) counts[normalizeSeverity(row.severity)]+=1;
  return { open:(rows.results||[]).length,resolved,...counts };
}

export async function getComplianceQueue(env, limit=200) {
  const result=await env.DB.prepare(`
    SELECT * FROM compliance_due_queue
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'ERROR' THEN 2 WHEN 'WARN' THEN 3 ELSE 4 END,
              due_at IS NULL,due_at
     LIMIT ?
  `).bind(Math.max(1,Math.min(Number(limit||200),1000))).all();
  return result.results||[];
}

function normalizeSeverity(value){
  const v=String(value||'WARN').toUpperCase();
  return ['INFO','WARN','ERROR','CRITICAL'].includes(v)?v:'WARN';
}
