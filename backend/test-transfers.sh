#!/bin/bash

# Test Transfer Endpoints

API="http://localhost:5000"

echo "🧪 Testing Transfer Endpoints"
echo "=============================="

# Get a facility ID - you may need to update this
FACILITY_ID="f460c478-1333-4ecf-bb09-0df7fd66781d"
COMMODITY_ID="c8f8f8f8-f8f8-f8f8-f8f8-f8f8f8f8f8f8" # Update with real commodity

echo -e "\n1️⃣  GET /api/transfers - Get all transfers for facility"
curl -X GET "$API/api/transfers?facility_id=$FACILITY_ID" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n\n"

echo -e "\n2️⃣  GET /api/transfers?status=pending - Get pending transfers"
curl -X GET "$API/api/transfers?facility_id=$FACILITY_ID&status=pending" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n\n"

echo -e "\n3️⃣  GET /api/transfers?type=incoming - Get incoming transfers"
curl -X GET "$API/api/transfers?facility_id=$FACILITY_ID&type=incoming" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n\n"

echo -e "\n4️⃣  POST /api/transfers - Create transfer request"
curl -X POST "$API/api/transfers" \
  -H "Content-Type: application/json" \
  -d '{
    "lines": [
      {
        "commodity_id": "'$COMMODITY_ID'",
        "quantity": 50,
        "qty_requested": 50
      }
    ],
    "receiving_facility_id": "f460c478-1333-4ecf-bb09-0df7fd66781d",
    "sending_facility_id": "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1",
    "transfer_type": "external_redistribution",
    "notes": "Test transfer",
    "initiated_by": "Test User",
    "section": "pharmacy"
  }' \
  -w "\nHTTP Status: %{http_code}\n\n"

echo "✅ Transfer endpoint tests complete!"
