// Outbound calls to EnVo's REST API. Network timeouts are common in the field, so
// everything here goes through retry().

const ATTEMPTS = 3;
const DELAY_MS = 3000;

export async function retry(fn, { attempts = ATTEMPTS, delayMs = DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// TODO: replace with real EnVo API call once the base URL and auth details are confirmed.
// The real implementation goes inside the retry() callback below; nothing else needs to
// change — routes/stock.js already consumes this shape.
export function fetchEnvoStock(facilityId) {
  return retry(async () => {
    // const res = await fetch(`${process.env.ENVO_API_URL}/facilities/${facilityId}/stock`, {
    //   headers: { Authorization: `Bearer ${process.env.ENVO_API_TOKEN}` },
    // });
    // if (!res.ok) throw new Error(`EnVo API returned ${res.status}`);
    // return res.json();

    return {
      facilityId,
      asOf: new Date().toISOString(),
      isMockData: true,
      items: [
        { commodityId: 'envo-mock-1', name: 'Amoxicillin 500mg', quantityOnHand: 420, unit: '1' },
        { commodityId: 'envo-mock-2', name: 'Gutt Gentamicin', quantityOnHand: 18, unit: 'bottle' },
        { commodityId: 'envo-mock-3', name: 'Amlodipine 10mg', quantityOnHand: 1250, unit: '1' },
      ],
    };
  });
}
