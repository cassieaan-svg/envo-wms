// The Phase 5 drill steps. Kept separate from the harness in commission.mjs so the two
// concerns stay readable: that file stands the instances up, this one exercises them.
//
// Every step receives the harness context rather than reaching for globals, which is what
// lets the whole drill be re-run, or a single section be run in isolation, without surprises.

export async function runDrill(ctx) {
  const { sql, api, check, section, start, stop, base, state, uid, login,
          CLOUD_DB, CMS_DB, SYNC_TOKEN, tokens, buildEnvelopeOnCms,
          buildStatusEnvelopeOnCms, runBackup, runRestore } = ctx;

  const balances = async () => {
    const { rows } = await sql(CMS_DB, `
      SELECT (SELECT quantity_remaining FROM commodity_batches WHERE uid = $1)::numeric AS batch,
             (SELECT COUNT(*)::int FROM batch_movements) AS movements,
             (SELECT COUNT(*)::int FROM inventory_transactions) AS txns`, [state.batchUid]);
    return { batch: Number(rows[0].batch), movements: rows[0].movements, txns: rows[0].txns };
  };

  const cloudCounts = async () => {
    const { rows } = await sql(CLOUD_DB, `
      SELECT (SELECT COUNT(*)::int FROM inventory_transactions) AS txns,
             (SELECT COUNT(*)::int FROM batch_movements) AS movements`);
    return rows[0];
  };

  const reconcile = async (db) => {
    const { rows } = await sql(db, `
      SELECT COUNT(*)::int c FROM (
        SELECT b.id FROM commodity_batches b
          LEFT JOIN batch_movements m ON m.batch_id = b.id
         GROUP BY b.id
        HAVING b.quantity_remaining <> COALESCE(SUM(m.quantity), 0)) x`);
    return rows[0].c;
  };

  const postEnvelope = (body) => fetch(`${base.cloud}/sync/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': SYNC_TOKEN },
    body: JSON.stringify(body),
  });

  // ── STEP 2 — Cloud becomes unreachable ────────────────────────────────────
  section('STEP 2 — Cloud goes away (CMS backend, database and LAN untouched)');
  await stop('cloud');
  let reachable = true;
  try { await fetch(`${base.cloud}/health`, { signal: AbortSignal.timeout(1500) }); }
  catch { reachable = false; }
  check('Cloud is genuinely unreachable from CMS', !reachable);
  check('CMS is still serving on the LAN', (await api('cms', '/health')).status === 200);

  // ── STEP 3 — offline fulfilment of the pre-synced request ─────────────────
  section('STEP 3 — dispatch the already-synced EnVo request, with Cloud down');
  const before = await balances();
  state.fulfilTxn = uid();
  const fulfil = await api('cms', `/api/requests/${state.cmsRequestId}/fulfil`, {
    method: 'POST',
    body: { carrierName: 'A. Driver', carrierPhone: '08012345678', pickedBy: 'Picker',
            dispatchedBy: 'Store Officer', clientTxnId: state.fulfilTxn },
  });
  check('offline fulfilment succeeds without Cloud', fulfil.status === 200,
    JSON.stringify(fulfil.data).slice(0, 140));

  const afterFulfil = await balances();
  check('quantity_remaining decreased by the dispatched amount',
    afterFulfil.batch === before.batch - 120, `${before.batch} -> ${afterFulfil.batch}`);
  check('a batch_movements row was written', afterFulfil.movements === before.movements + 1);
  check('an inventory_transactions row was written', afterFulfil.txns === before.txns + 1);

  const { rows: fx } = await sql(CMS_DB,
    `SELECT uid, origin, source_instance, synced_at FROM inventory_transactions
      WHERE client_txn_id = $1`, [state.fulfilTxn]);
  check('the transaction is stamped origin=cms / source_instance=cms-uyo',
    fx[0]?.origin === 'cms' && fx[0]?.source_instance === 'cms-uyo',
    `${fx[0]?.origin} / ${fx[0]?.source_instance}`);
  check('it is durable locally and NOT yet synced', !!fx[0] && fx[0].synced_at === null);

  const { rows: ob } = await sql(CMS_DB,
    `SELECT COUNT(*)::int c FROM outbox WHERE kind = 'sync_transaction' AND delivered_at IS NULL`);
  check('a sync item is waiting in the CMS outbox', ob[0].c >= 1, `${ob[0].c} pending`);

  // Printing. The dispatch document is rendered from this payload; if it is complete with
  // Cloud down, the browser can produce the waybill with Cloud down.
  const { rows: ordRow } = await sql(CMS_DB,
    'SELECT dispatch_order_id FROM requests WHERE id = $1', [state.cmsRequestId]);
  state.fulfilOrderId = ordRow[0].dispatch_order_id;
  const doc = await api('cms', `/api/dispatch-orders/${state.fulfilOrderId}`);
  const printable = doc.status === 200 && doc.data?.items?.length > 0
    && doc.data.items[0].batches?.length > 0;
  check('the dispatch document renders offline, lots and all', printable,
    `order #${doc.data?.id}, ${doc.data?.items?.length} line(s), lot ` +
    `${doc.data?.items?.[0]?.batches?.[0]?.batchNumber}`);

  // ── STEP 4 — a brand-new direct dispatch, still offline ───────────────────
  section('STEP 4 — a NEW direct dispatch with no EnVo request, still offline');
  state.directTxn = uid();
  const direct = await api('cms', `/api/facilities/${state.facilityId}/dispatch-orders`, {
    method: 'POST',
    body: { items: [{ commodityId: state.commodityId, quantity: 40, unitPrice: 25 }],
            scheme: 'drf', dispatchedBy: 'Store Officer', clientTxnId: state.directTxn },
  });
  check('offline direct dispatch succeeds', direct.status === 201,
    JSON.stringify(direct.data).slice(0, 140));
  state.directOrderId = direct.data?.id;

  const afterDirect = await balances();
  check('stock decreased again', afterDirect.batch === afterFulfil.batch - 40,
    `${afterFulfil.batch} -> ${afterDirect.batch}`);
  const { rows: notReq } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM requests WHERE dispatch_order_id = $1', [state.directOrderId]);
  check('the direct dispatch is linked to NO request', notReq[0].c === 0);
  const directDoc = await api('cms', `/api/dispatch-orders/${state.directOrderId}`);
  check('its document renders offline too', directDoc.status === 200 && directDoc.data?.items?.length === 1);

  // H — several offline dispatches before reconnecting
  state.extraTxns = [];
  for (let i = 0; i < 3; i += 1) {
    const t = uid();
    state.extraTxns.push(t);
    const r = await api('cms', `/api/facilities/${state.facilityId}/dispatch-orders`, {
      method: 'POST',
      body: { items: [{ commodityId: state.commodityId, quantity: 5, unitPrice: 25 }],
              scheme: 'drf', dispatchedBy: 'Store Officer', clientTxnId: t },
    });
    if (r.status !== 201) check(`extra offline dispatch ${i + 1}`, false, JSON.stringify(r.data));
  }
  const afterExtra = await balances();
  check('H: several offline dispatches in a row all succeed',
    afterExtra.batch === afterDirect.batch - 15, `${afterDirect.batch} -> ${afterExtra.batch}`);

  // ── STEP 5 — restart CMS while Cloud is still down ────────────────────────
  section('STEP 5 — restart the CMS process, Cloud still unreachable');
  const beforeRestart = await balances();
  const { rows: pendBefore } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE synced_at IS NULL');
  await stop('cms');
  await start('cms');
  await login('cms', 'cms.officer', 'commission-pass');
  const afterRestart = await balances();
  const { rows: pendAfter } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE synced_at IS NULL');

  check('C: local data survived the restart intact',
    afterRestart.batch === beforeRestart.batch
    && afterRestart.movements === beforeRestart.movements
    && afterRestart.txns === beforeRestart.txns, JSON.stringify(afterRestart));
  check('C: pending transactions are still pending, and none was duplicated',
    pendAfter[0].c === pendBefore[0].c, `${pendBefore[0].c} -> ${pendAfter[0].c}`);
  check('C: users can carry on working after the restart',
    (await api('cms', '/api/requests')).status === 200);

  // I — a long outage changes nothing operationally except master-data age
  await sql(CMS_DB, `UPDATE sync_state SET last_success_at = now() - interval '5 hours'
                      WHERE stream = 'master_data'`);
  const statusOffline = await api('cms', '/api/sync/status');
  check('I: hours offline — work is held, not lost, and the warehouse says so',
    statusOffline.status === 200 && statusOffline.data.pendingTransactions >= 5,
    `${statusOffline.data?.pendingTransactions} held, master data ` +
    `${statusOffline.data?.masterData?.staleness?.level}`);

  // ── STEP 6 — Cloud returns ────────────────────────────────────────────────
  section('STEP 6 — Cloud comes back; CMS pushes everything it did alone');
  await start('cloud');
  const cloudBefore = await cloudCounts();
  const heldCount = pendAfter[0].c;

  const drain = await api('cms', '/api/sync/run', { method: 'POST' });
  check('CMS sync runs cleanly on reconnect',
    drain.status === 200 && (drain.data.errors || []).length === 0,
    JSON.stringify(drain.data?.outbox || drain.data?.errors));

  const cloudAfter = await cloudCounts();
  const { rows: stillPending } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE synced_at IS NULL');
  check('every held transaction reached Cloud', stillPending[0].c === 0,
    `${stillPending[0].c} still pending`);
  check('Cloud gained exactly the transactions CMS was holding',
    cloudAfter.txns === cloudBefore.txns + heldCount,
    `${cloudBefore.txns} -> ${cloudAfter.txns} (held ${heldCount})`);

  // ── Data validation ───────────────────────────────────────────────────────
  section('DATA VALIDATION — Cloud vs CMS, on the rows that should have synced');
  const { rows: cmsTx } = await sql(CMS_DB,
    'SELECT client_txn_id, uid, origin, source_instance FROM inventory_transactions ORDER BY client_txn_id');
  const { rows: cloudTx } = await sql(CLOUD_DB,
    'SELECT client_txn_id, uid, origin, source_instance FROM inventory_transactions ORDER BY client_txn_id');
  const cloudByKey = new Map(cloudTx.map((t) => [t.client_txn_id, t]));

  let uidMatch = 0; let originMatch = 0; let missing = 0;
  for (const t of cmsTx) {
    const c = cloudByKey.get(t.client_txn_id);
    if (!c) { missing += 1; continue; }
    if (c.uid === t.uid) uidMatch += 1;
    if (c.origin === 'cms' && c.source_instance === 'cms-uyo') originMatch += 1;
  }
  check('every CMS transaction is present on Cloud', missing === 0, `${missing} missing`);
  check('transaction uids are identical across the two instances',
    uidMatch === cmsTx.length, `${uidMatch}/${cmsTx.length}`);
  check('Cloud preserved origin=cms and source_instance=cms-uyo',
    originMatch === cmsTx.length, `${originMatch}/${cmsTx.length}`);

  const { rows: cloudMv } = await sql(CLOUD_DB, 'SELECT uid FROM batch_movements');
  const distinct = new Set(cloudMv.map((m) => m.uid)).size;
  check('no movement was duplicated on Cloud', cloudMv.length === distinct,
    `${cloudMv.length} rows, ${distinct} distinct uids`);

  const { rows: cmsBal } = await sql(CMS_DB,
    'SELECT quantity_remaining FROM commodity_batches WHERE uid = $1', [state.batchUid]);
  const { rows: cloudBal } = await sql(CLOUD_DB,
    'SELECT quantity_remaining FROM commodity_batches WHERE uid = $1', [state.batchUid]);
  check('Cloud mirrors the batch balance CMS reports',
    Number(cloudBal[0]?.quantity_remaining) === Number(cmsBal[0].quantity_remaining),
    `cms ${cmsBal[0].quantity_remaining} / cloud ${cloudBal[0]?.quantity_remaining}`);

  const { rows: unlinked } = await sql(CLOUD_DB,
    `SELECT COUNT(*)::int c FROM dispatch_orders o
       LEFT JOIN requests r ON r.dispatch_order_id = o.id WHERE r.id IS NULL`);
  check('direct dispatches arrived on Cloud as direct issues, never as EnVo requests',
    unlinked[0].c === 4, `${unlinked[0].c} unlinked order(s) — 1 direct + 3 extra`);

  const { rows: reqOnCloud } = await sql(CLOUD_DB,
    'SELECT status, picked_by, carrier_name FROM requests WHERE envo_request_id = $1',
    [state.envoRequestId]);
  check('Cloud shows the request dispatched, with its chain of custody',
    reqOnCloud[0]?.status === 'dispatched' && !!reqOnCloud[0]?.carrier_name,
    JSON.stringify(reqOnCloud[0]));

  const { rows: envoCb } = await sql(CLOUD_DB,
    `SELECT COUNT(*)::int c FROM outbox WHERE kind = 'request_status'
       AND payload->>'envoRequestId' = $1`, [state.envoRequestId]);
  check('Cloud queued the EnVo callback for the fulfilled request', envoCb[0].c >= 1,
    `${envoCb[0].c} callback(s) queued`);

  // ── Failure tests ─────────────────────────────────────────────────────────
  section('FAILURE TESTS — duplicates, bad origin, incomplete history');
  const env = await buildEnvelopeOnCms(state.directTxn);

  const dup1 = await postEnvelope(env);
  const dup2 = await postEnvelope(env);
  const d1 = await dup1.json().catch(() => ({}));
  const d2 = await dup2.json().catch(() => ({}));
  check('A/E: a re-delivered transaction is answered as a duplicate, not applied again',
    dup1.status === 200 && d1.duplicate === true && d2.duplicate === true,
    `${dup1.status}/${dup2.status}`);

  const { rows: dupCount } = await sql(CLOUD_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [state.directTxn]);
  check('M: exactly one transaction exists on Cloud for that client_txn_id', dupCount[0].c === 1);

  const badOrigin = await postEnvelope({ ...env, clientTxnId: uid(),
    txn: { ...env.txn, uid: crypto.randomUUID(), origin: 'cloud' } });
  check('K/L: Cloud refuses an envelope not authored by CMS', badOrigin.status === 403,
    `status ${badOrigin.status}`);

  const noToken = await fetch(`${base.cloud}/sync/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) });
  check('L: the sync surface rejects an unauthenticated caller', noToken.status === 401);

  const batchUid = crypto.randomUUID();
  const orphan = {
    clientTxnId: uid(),
    txn: { uid: crypto.randomUUID(), operation: 'dispatch', origin: 'cms',
           sourceInstance: 'cms-uyo', createdAt: new Date().toISOString(), result: null },
    batches: [{ uid: batchUid, commodity_id: state.commodityId, batch_number: 'COMM-LOT-Z',
                expiry_date: '2032-01-01', quantity_received: 900, quantity_remaining: 850,
                received_date: '2026-01-01', created_by: 'cms', origin: 'cms',
                source_instance: 'cms-uyo', unit_cost: null, vendor_id: null }],
    movements: [{ uid: crypto.randomUUID(), batch_uid: batchUid, movement_type: 'dispatch',
                  quantity: -50, created_at: new Date().toISOString(), origin: 'cms',
                  source_instance: 'cms-uyo' }],
    order: null, request: null,
  };
  const orphanRes = await postEnvelope(orphan);
  check('J: Cloud accepts a batch whose earlier history it never received',
    orphanRes.status === 201,
    `status ${orphanRes.status} — the mirror takes CMS at its word; its own ledger is partial by design`);

  const truncated = { ...orphan, clientTxnId: uid(), batches: [],
                      txn: { ...orphan.txn, uid: crypto.randomUUID() } };
  const truncRes = await postEnvelope(truncated);
  check('J: but refuses an envelope omitting a batch its movements reference',
    truncRes.status === 422, `status ${truncRes.status}`);

  // ── Interruption and restart ──────────────────────────────────────────────
  section('FAILURE TESTS — interrupted sync and Cloud restart');
  const interruptTxn = uid();
  const extra = await api('cms', `/api/facilities/${state.facilityId}/dispatch-orders`, {
    method: 'POST',
    body: { items: [{ commodityId: state.commodityId, quantity: 3, unitPrice: 25 }],
            scheme: 'drf', dispatchedBy: 'Store Officer', clientTxnId: interruptTxn },
  });
  check('a further dispatch is recorded, ready to be interrupted', extra.status === 201);

  await stop('cloud');
  const failedDrain = await api('cms', '/api/sync/run', { method: 'POST' });
  check('B: a sync against a dead Cloud fails without losing the work',
    failedDrain.status === 200 && (failedDrain.data.errors || []).length > 0,
    (failedDrain.data.errors || []).join(' | ').slice(0, 90));
  const { rows: heldStill } = await sql(CMS_DB,
    'SELECT synced_at FROM inventory_transactions WHERE client_txn_id = $1', [interruptTxn]);
  check('B: the transaction is still marked unsynced after the failure',
    heldStill[0]?.synced_at === null);

  await start('cloud');
  const recovered = await api('cms', '/api/sync/run', { method: 'POST' });
  check('D: once Cloud restarts, the pending work is delivered',
    recovered.status === 200 && (recovered.data.errors || []).length === 0,
    JSON.stringify(recovered.data.outbox));
  const { rows: nowSynced } = await sql(CMS_DB,
    'SELECT synced_at FROM inventory_transactions WHERE client_txn_id = $1', [interruptTxn]);
  check('D: and it is now recorded as synced', nowSynced[0]?.synced_at !== null);

  const { rows: fCheck } = await sql(CLOUD_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [state.fulfilTxn]);
  check('F: the offline-fulfilled EnVo request reached Cloud', fCheck[0].c === 1);
  const { rows: gCheck } = await sql(CLOUD_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [state.directTxn]);
  check('G: the offline direct dispatch reached Cloud', gCheck[0].c === 1);

  // ── Reconciliation on both sides ──────────────────────────────────────────
  section('RECONCILIATION — each instance against its own ledger');
  const cmsRecon = await reconcile(CMS_DB);
  check('CMS reconciles: every batch agrees with its movements', cmsRecon === 0,
    `${cmsRecon} discrepancy(ies)`);

  const { rows: cmsEnvo } = await sql(CMS_DB,
    "SELECT COUNT(*)::int c FROM outbox WHERE kind = 'request_status'");
  check('CMS never queued an EnVo callback it could not deliver', cmsEnvo[0].c === 0,
    `${cmsEnvo[0].c} row(s) — EnVo is Cloud's relationship`);

  const { rows: cmsUndeliverable } = await sql(CMS_DB,
    "SELECT COUNT(*)::int c FROM outbox WHERE delivered_at IS NULL");
  check('nothing is stuck undeliverable in the CMS outbox', cmsUndeliverable[0].c === 0,
    `${cmsUndeliverable[0].c} undelivered`);
  const cloudRecon = await reconcile(CLOUD_DB);
  check('Cloud mirror variance is confined to history it never received',
    cloudRecon <= 2, `${cloudRecon} batch(es) differ — expected for a partial mirror`);

  // ── Ordering / causality ──────────────────────────────────────────────────
  section('ORDERING — a reversal must never overtake the dispatch it reverses');
  const orderTxn = uid();
  const ord = await api('cms', `/api/facilities/${state.facilityId}/dispatch-orders`, {
    method: 'POST',
    body: { items: [{ commodityId: state.commodityId, quantity: 20, unitPrice: 25 }],
            scheme: 'drf', dispatchedBy: 'Store Officer', clientTxnId: orderTxn },
  });
  const editTxn = uid();
  const edited = await api('cms', `/api/dispatch-orders/${ord.data.id}`, {
    method: 'PUT',
    body: { items: [{ commodityId: state.commodityId, quantity: 8, unitPrice: 25 }],
            clientTxnId: editTxn },
  });
  check('an order raised and then edited offline both succeed',
    ord.status === 201 && edited.status === 200);

  const syncOrdered = await api('cms', '/api/sync/run', { method: 'POST' });
  check('both reach Cloud on the next sync',
    syncOrdered.status === 200 && (syncOrdered.data.errors || []).length === 0
    && (syncOrdered.data.outbox?.delivered || 0) >= 2,
    JSON.stringify(syncOrdered.data.outbox));

  const { rows: seq } = await sql(CLOUD_DB,
    `SELECT t.client_txn_id, m.movement_type, m.id
       FROM batch_movements m JOIN inventory_transactions t ON t.id = m.txn_id
      WHERE t.client_txn_id = ANY($1) ORDER BY m.id`, [[orderTxn, editTxn]]);
  const firstDispatch = seq.findIndex((r) => r.movement_type === 'dispatch');
  const reversal = seq.findIndex((r) => r.movement_type === 'reversal');
  check('Cloud received the dispatch before its reversal',
    firstDispatch !== -1 && reversal !== -1 && firstDispatch < reversal,
    seq.map((r) => r.movement_type).join(' -> '));

  // ── 5.5 — request status events reach Cloud and EnVo ──────────────────────
  section('5.5 — request status events (picking / rejected / dispatched) reach Cloud');
  const { rows: cmsEvents } = await sql(CMS_DB,
    'SELECT status, synced_at FROM request_status_events ORDER BY id');
  check('CMS recorded a status event for each transition it performed', cmsEvents.length >= 1,
    cmsEvents.map((e) => e.status).join(', '));

  const syncStatus = await api('cms', '/api/sync/run', { method: 'POST' });
  check('status events sync to Cloud',
    syncStatus.status === 200 && (syncStatus.data.errors || []).length === 0,
    JSON.stringify(syncStatus.data.outbox));

  const { rows: unsyncedEv } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM request_status_events WHERE synced_at IS NULL');
  check('no status event is left behind on CMS', unsyncedEv[0].c === 0, `${unsyncedEv[0].c} unsynced`);

  const { rows: cloudEvents } = await sql(CLOUD_DB,
    'SELECT status, origin, source_instance FROM request_status_events ORDER BY id');
  check('Cloud received them, stamped as CMS work',
    cloudEvents.length >= 1
    && cloudEvents.every((e) => e.origin === 'cms' && e.source_instance === 'cms-uyo'),
    cloudEvents.map((e) => e.status).join(', '));

  const { rows: cbAll } = await sql(CLOUD_DB,
    `SELECT payload->>'status' AS st, COUNT(*)::int AS c FROM outbox
      WHERE kind = 'request_status' GROUP BY 1 ORDER BY 1`);
  check('Cloud queued exactly one EnVo callback per status',
    cbAll.every((r) => r.c === 1), cbAll.map((r) => `${r.st}:${r.c}`).join(' '));
  const cbTotal = cbAll.reduce((a, r) => a + r.c, 0);

  const { rows: anyEvent } = await sql(CMS_DB, 'SELECT uid FROM request_status_events LIMIT 1');
  const evEnvelope = await buildStatusEnvelopeOnCms(anyEvent[0].uid);
  const replay = await fetch(`${base.cloud}/sync/request-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': SYNC_TOKEN },
    body: JSON.stringify(evEnvelope),
  });
  const replayBody = await replay.json().catch(() => ({}));
  check('a re-delivered status event is a duplicate, not a second callback',
    replay.status === 200 && replayBody.duplicate === true, `status ${replay.status}`);

  const { rows: cbAfter } = await sql(CLOUD_DB,
    `SELECT COUNT(*)::int c FROM outbox WHERE kind = 'request_status'`);
  check('the EnVo callback count is unchanged by the replay', cbAfter[0].c === cbTotal,
    `${cbTotal} -> ${cbAfter[0].c}`);

  // ── 5.5 — reprints ────────────────────────────────────────────────────────
  section('5.5 — reprints are numbered, and move no stock');
  const beforePrint = await balances();
  const p1 = await api('cms', `/api/dispatch-orders/${state.fulfilOrderId}/print`,
    { method: 'POST', body: { printedBy: 'Store Officer' } });
  const p2 = await api('cms', `/api/dispatch-orders/${state.fulfilOrderId}/print`,
    { method: 'POST', body: { printedBy: 'Store Officer' } });
  const p3 = await api('cms', `/api/dispatch-orders/${state.fulfilOrderId}/print`,
    { method: 'POST', body: { printedBy: 'Night Officer' } });
  check('the copies are labelled ORIGINAL, REPRINT #1, REPRINT #2',
    p1.data?.label === 'ORIGINAL' && p2.data?.label === 'REPRINT #1' && p3.data?.label === 'REPRINT #2',
    [p1.data?.label, p2.data?.label, p3.data?.label].join(' / '));

  const afterPrint = await balances();
  check('printing moved no stock, wrote no movement and no transaction',
    afterPrint.batch === beforePrint.batch && afterPrint.movements === beforePrint.movements
    && afterPrint.txns === beforePrint.txns, JSON.stringify(afterPrint));

  const prints = await api('cms', `/api/dispatch-orders/${state.fulfilOrderId}/prints`);
  check('every copy is logged with who took it',
    prints.data?.length === 3 && prints.data[2].printed_by === 'Night Officer');

  // ── 5.5 — backup and restore ──────────────────────────────────────────────
  section('5.5 — CMS backup, restore, and synchronisation resuming afterwards');
  const beforeBackup = await balances();
  const { rows: pendBeforeBackup } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE synced_at IS NULL');

  const backupFile = await runBackup();
  check('pg_dump of the CMS database succeeds', !!backupFile, backupFile || 'no file produced');

  // Work done AFTER the backup, to show exactly what a restore does and does not bring back.
  const postBackupTxn = uid();
  const postBackup = await api('cms', `/api/facilities/${state.facilityId}/dispatch-orders`, {
    method: 'POST',
    body: { items: [{ commodityId: state.commodityId, quantity: 7, unitPrice: 25 }],
            scheme: 'drf', dispatchedBy: 'Store Officer', clientTxnId: postBackupTxn },
  });
  check('a dispatch is recorded after the backup was taken', postBackup.status === 201);

  await stop('cms');
  const restored = await runRestore(backupFile);
  check('the CMS database restores from the dump', restored);
  await start('cms');
  await login('cms', 'cms.officer', 'commission-pass');

  const afterRestore = await balances();
  check('stock survived the restore', afterRestore.batch === beforeBackup.batch,
    `${beforeBackup.batch} -> ${afterRestore.batch}`);
  check('movements survived the restore', afterRestore.movements === beforeBackup.movements,
    `${beforeBackup.movements} -> ${afterRestore.movements}`);
  check('inventory transactions survived the restore', afterRestore.txns === beforeBackup.txns,
    `${beforeBackup.txns} -> ${afterRestore.txns}`);

  const { rows: pendAfterRestore } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE synced_at IS NULL');
  check('pending sync state survived the restore',
    pendAfterRestore[0].c === pendBeforeBackup[0].c,
    `${pendBeforeBackup[0].c} -> ${pendAfterRestore[0].c}`);

  const { rows: lostWork } = await sql(CMS_DB,
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [postBackupTxn]);
  check('work done AFTER the backup is gone — the RPO window, made visible',
    lostWork[0].c === 0,
    'this is what an hourly backup costs at worst, and why frequent sync is the second copy');

  const opAfter = await api('cms', `/api/facilities/${state.facilityId}/dispatch-orders`, {
    method: 'POST',
    body: { items: [{ commodityId: state.commodityId, quantity: 2, unitPrice: 25 }],
            scheme: 'drf', dispatchedBy: 'Store Officer', clientTxnId: uid() },
  });
  check('CMS keeps operating after the restore', opAfter.status === 201,
    JSON.stringify(opAfter.data).slice(0, 100));

  const resumed = await api('cms', '/api/sync/run', { method: 'POST' });
  check('synchronisation resumes after the restore',
    resumed.status === 200 && (resumed.data.errors || []).length === 0,
    JSON.stringify(resumed.data.outbox));

  const { rows: cloudDupes } = await sql(CLOUD_DB,
    `SELECT client_txn_id FROM inventory_transactions GROUP BY 1 HAVING COUNT(*) > 1`);
  check('the restore created no duplicate transaction on Cloud', cloudDupes.length === 0,
    `${cloudDupes.length} duplicated key(s)`);

  const { rows: finalCms } = await sql(CMS_DB,
    'SELECT quantity_remaining FROM commodity_batches WHERE uid = $1', [state.batchUid]);
  const { rows: finalCloud } = await sql(CLOUD_DB,
    'SELECT quantity_remaining FROM commodity_batches WHERE uid = $1', [state.batchUid]);
  check('after everything, both instances agree on the batch balance',
    Number(finalCms[0].quantity_remaining) === Number(finalCloud[0].quantity_remaining),
    `cms ${finalCms[0].quantity_remaining} / cloud ${finalCloud[0].quantity_remaining}`);
}
