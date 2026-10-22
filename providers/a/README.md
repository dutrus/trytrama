# Andes Wholesale — Availability API v1

Andes Wholesale distributes hotel inventory across Argentina, Brazil and Mexico for travel agencies.
This document describes the **Availability API v1**.

> Local sandbox: `http://localhost:4001`

## Authentication

Every request must include your API key:

```
X-Api-Key: <your key>
```

Any non-empty key works in sandbox. Requests without a key get `401`.

## Rate limits

Fair use. Please don't hammer us.

---

## `GET /v1/destinations`

Lists the destinations you can search.

```json
{
  "destinations": [
    { "code": "bariloche", "name": "San Carlos de Bariloche", "country": "AR" },
    { "code": "mendoza", "name": "Mendoza", "country": "AR" }
  ]
}
```

## `GET /v1/availability`

Returns available hotels and rooms for a destination and stay.

### Query parameters

| Name          | Type   | Required | Description                                  |
|---------------|--------|----------|----------------------------------------------|
| `destination` | string | yes      | Destination `code` from `/v1/destinations`.  |
| `checkIn`     | string | yes      | `YYYY-MM-DD`                                 |
| `checkOut`    | string | yes      | `YYYY-MM-DD`. Max 30 nights.                 |
| `adults`      | int    | no       | Default `2`. 1–6.                            |
| `children`    | int    | no       | Default `0`. 0–4.                            |

All guests are assumed to share **one room**. Only rooms that fit all guests are returned.

### Example

```bash
curl -H 'X-Api-Key: demo' \
  'http://localhost:4001/v1/availability?destination=bariloche&checkIn=2026-12-01&checkOut=2026-12-05&adults=2'
```

```json
{
  "searchId": "aw_gs4dv90f40hx",
  "destination": "bariloche",
  "checkIn": "2026-12-01",
  "checkOut": "2026-12-05",
  "currency": "USD",
  "hotels": [
    {
      "hotelId": "AW-10002",
      "name": "Cabañas Cerro Otto",
      "starRating": 4,
      "address": "Elflein 1597",
      "geo": { "lat": -41.134521, "lng": -71.294469 },
      "rooms": [
        {
          "roomCode": "TWN-BB",
          "roomName": "Twin Standard - Bed & breakfast",
          "boardType": "BB",
          "maxOccupancy": 2,
          "totalPrice": 766.1,
          "refundable": true
        }
      ]
    }
  ]
}
```

### Hotel object

| Field        | Type    | Notes                                   |
|--------------|---------|-----------------------------------------|
| `hotelId`    | string  | Stable Andes Wholesale id.              |
| `name`       | string  |                                         |
| `starRating` | integer | **Required.** 1–5.                      |
| `address`    | string  |                                         |
| `geo`        | object  | `{ lat, lng }`, WGS84.                  |
| `rooms`      | array   | At least one room.                      |

### Room object

| Field          | Type    | Notes                                               |
|----------------|---------|-----------------------------------------------------|
| `roomCode`     | string  | Unique within the hotel.                            |
| `roomName`     | string  | Human readable, English.                            |
| `boardType`    | enum    | `RO` (room only), `BB`, `HB` (half board), `FB`.     |
| `maxOccupancy` | integer |                                                     |
| `totalPrice`   | number  | Total price for the stay, in `currency`.            |
| `refundable`   | boolean | Whether the rate can be cancelled without penalty.  |

Taxes and fees may apply at the property.

## Errors

Errors use standard HTTP status codes and a JSON body:

```json
{ "error": "VALIDATION", "message": "checkOut must be after checkIn" }
```

| Status | `error`        | When                                   |
|--------|----------------|----------------------------------------|
| 400    | `VALIDATION`   | Bad or missing parameters.             |
| 401    | `UNAUTHORIZED` | Missing API key.                       |
| 500    | `INTERNAL`     | Something went wrong on our side. Retry. |

## Changelog

- **v1.4** — added `maxOccupancy`.
- **v1.3** — `geo` is now always returned.
