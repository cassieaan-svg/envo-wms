// AccountService/payments had zero test coverage despite being one of the most carefully
// guarded services in the codebase — idempotency, row locking, overpayment/over-reversal
// refusal, and a unique receipt number turned into a clear 409 rather than a raw constraint
// error. Flagged in the workflow audit; this closes the gap.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { DispatchService } from '../src/services/dispatchService.js';
import { AccountService } from '../src/services/accountService.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch, cleanup, txnId, scheme,
} from './helpers.js';

test.after(async () => { await pool.end(); });

// A debt-bearing order (the DRF, per migration 028) to pay against.
async function debtOrder(user, facility, commodity, { total = 100, unitPrice = 10 } = {}) {
  await makeBatch(commodity.id, 500);
  const order = await DispatchService.createOrder({
    facilityId: facility.id,
    items: [{ commodityId: commodity.id, quantity: total / unitPrice, unitPrice }],
    dispatchedBy: 'Store Officer',
    scheme: await scheme(), // 'drf', creates_debt
    clientTxnId: txnId('ACC-ORDER'),
    actorUserId: user.id,
  });
  return order;
}

async function nonDebtOrder(user, facility, commodity, { total = 100, unitPrice = 10 } = {}) {
  await makeBatch(commodity.id, 500);
  const order = await DispatchService.createOrder({
    facilityId: facility.id,
    items: [{ commodityId: commodity.id, quantity: total / unitPrice, unitPrice }],
    dispatchedBy: 'Store Officer',
    scheme: 'bhcpf', // does not create debt
    clientTxnId: txnId('ACC-ORDER-ND'),
    actorUserId: user.id,
  });
  return order;
}

test('recording a payment reduces the outstanding balance', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity);

  try {
    const balance = await AccountService.recordPayment(order.id, {
      amount: 40, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY'), actorUserId: user.id,
    });
    assert.equal(Number(balance.amount_paid), 40);
    assert.equal(Number(balance.outstanding), 60);

    const payments = await AccountService.payments(order.id);
    assert.equal(payments.length, 1);
    assert.equal(Number(payments[0].amount), 40);
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('a retried payment (same clientTxnId) is answered with the original balance, not applied twice', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity);
  const id = txnId('PAY-RETRY');
  const receiptNo = `R-${txnId()}`;

  try {
    const first = await AccountService.recordPayment(order.id, {
      amount: 40, recordedBy: 'Cashier', receiptNo, clientTxnId: id, actorUserId: user.id,
    });
    const second = await AccountService.recordPayment(order.id, {
      amount: 40, recordedBy: 'Cashier', receiptNo, clientTxnId: id, actorUserId: user.id,
    });

    assert.equal(Number(second.amount_paid), Number(first.amount_paid), 'the retry did not add a second 40');
    assert.equal(Number(second.amount_paid), 40);

    const payments = await AccountService.payments(order.id);
    assert.equal(payments.length, 1, 'only one payment row exists');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('a payment exceeding the outstanding balance is refused', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity); // total 100

  try {
    await assert.rejects(
      AccountService.recordPayment(order.id, {
        amount: 150, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-OVER'), actorUserId: user.id,
      }),
      /exceeds the outstanding balance/
    );
    const balance = await AccountService.balance(order.id);
    assert.equal(Number(balance.amount_paid), 0, 'nothing was banked');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('reversing more than has been paid is refused', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity);

  try {
    await AccountService.recordPayment(order.id, {
      amount: 30, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-A'), actorUserId: user.id,
    });
    await assert.rejects(
      AccountService.recordPayment(order.id, {
        amount: -50, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-REV'), actorUserId: user.id,
      }),
      /cannot reverse more than has been paid/
    );
    const balance = await AccountService.balance(order.id);
    assert.equal(Number(balance.amount_paid), 30, 'the over-reversal was refused, not partially applied');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('a negative amount within what was paid records a correction', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity);

  try {
    await AccountService.recordPayment(order.id, {
      amount: 50, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-A'), actorUserId: user.id,
    });
    const balance = await AccountService.recordPayment(order.id, {
      amount: -20, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, note: 'entered in error', clientTxnId: txnId('PAY-CORR'), actorUserId: user.id,
    });
    assert.equal(Number(balance.amount_paid), 30);
    assert.equal(Number(balance.outstanding), 70);

    const payments = await AccountService.payments(order.id);
    assert.equal(payments.length, 2, 'the correction is a new row, not an edit of the original');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('reusing a receipt number is a clear 409, not a raw constraint error', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity);
  const receiptNo = `R-${txnId()}`;

  try {
    await AccountService.recordPayment(order.id, {
      amount: 20, recordedBy: 'Cashier', receiptNo, clientTxnId: txnId('PAY-A'), actorUserId: user.id,
    });
    await assert.rejects(
      AccountService.recordPayment(order.id, {
        amount: 20, recordedBy: 'Cashier', receiptNo, clientTxnId: txnId('PAY-B'), actorUserId: user.id,
      }),
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /has already been recorded/);
        return true;
      }
    );
    const balance = await AccountService.balance(order.id);
    assert.equal(Number(balance.amount_paid), 20, 'only the first payment landed');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('a payment against a non-debt-bearing order is refused', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await nonDebtOrder(user, facility, commodity);

  try {
    await assert.rejects(
      AccountService.recordPayment(order.id, {
        amount: 10, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-ND'), actorUserId: user.id,
      }),
      /are not billed to the facility/
    );
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('a zero amount is refused, and a receipt number is required', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity);

  try {
    await assert.rejects(
      AccountService.recordPayment(order.id, {
        amount: 0, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-Z'), actorUserId: user.id,
      }),
      /non-zero amount is required/
    );
    await assert.rejects(
      AccountService.recordPayment(order.id, {
        amount: 10, recordedBy: 'Cashier', clientTxnId: txnId('PAY-NR'), actorUserId: user.id,
      }),
      /receipt number is required/
    );
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('recording a payment against an unknown order is a 404', async () => {
  await assert.rejects(
    AccountService.recordPayment(2_147_483_000, {
      amount: 10, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-404'), actorUserId: null,
    }),
    /dispatch order not found/
  );
});

test('two concurrent payments cannot both overdraw the outstanding balance', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity); // total 100, outstanding 100

  try {
    // Two payments of 70 each, at once — together they would overpay by 40. The row lock
    // serialises them: the first to commit reads the fresh outstanding figure, the second
    // sees it already reduced and is refused.
    const results = await Promise.allSettled([
      AccountService.recordPayment(order.id, {
        amount: 70, recordedBy: 'Cashier A', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-C1'), actorUserId: user.id,
      }),
      AccountService.recordPayment(order.id, {
        amount: 70, recordedBy: 'Cashier B', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-C2'), actorUserId: user.id,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one payment succeeded');
    assert.equal(rejected.length, 1, 'the other was refused, not both accepted');

    const balance = await AccountService.balance(order.id);
    assert.equal(Number(balance.amount_paid), 70, 'the balance reflects exactly one payment');
    assert.ok(Number(balance.outstanding) >= 0, 'never overdrawn');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('debtors/outstandingOrders/settled reflect a payment moving an order from owing to clear', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const order = await debtOrder(user, facility, commodity); // total 100

  try {
    let outstanding = await AccountService.outstandingOrders({ facilityId: facility.id });
    assert.equal(outstanding.length, 1);
    let debtors = await AccountService.debtors();
    assert.ok(debtors.some((d) => d.facility_id === facility.id));

    await AccountService.recordPayment(order.id, {
      amount: 100, recordedBy: 'Cashier', receiptNo: `R-${txnId()}`, clientTxnId: txnId('PAY-FULL'), actorUserId: user.id,
    });

    outstanding = await AccountService.outstandingOrders({ facilityId: facility.id });
    assert.equal(outstanding.length, 0, 'no longer outstanding once fully paid');

    debtors = await AccountService.debtors();
    assert.ok(!debtors.some((d) => d.facility_id === facility.id), 'the facility drops off the debtors list once clear');

    const settled = await AccountService.settled({ facilityId: facility.id });
    assert.equal(settled.length, 1, 'the order now appears in settlement history');
    assert.equal(settled[0].instalments, 1);
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});
