# LegacyGDS — Hotel Interface Specification

```
Document:  LGDS-HTL-IF   Rev. 3.2 (2019)
Transport: HTTP POST, XML (SOAP-style envelope)
Endpoint:  http://localhost:4003/gds
```

## 1. General

All messages are sent as an XML `Envelope` via `POST /gds`. The operation is selected
by the element inside `Body`. Credentials are mandatory in every message.

Throughput is limited to **5 transactions per second** per account. Over the limit the
host returns `HTTP 429` with a `Retry-After` header (seconds).

All amounts are in **USD**. Rates are **net** (taxes not included). See section 4.

## 2. Destination codes

| Code | City                    |
|------|-------------------------|
| BRC  | San Carlos de Bariloche |
| MDZ  | Mendoza                 |
| SLA  | Salta                   |
| FLN  | Florianopolis           |
| CUN  | Cancun                  |

## 3. HotelAvailRQ / HotelAvailRS

### Request

```xml
<Envelope>
  <Header>
    <Credentials user="trama" password="demo"/>
  </Header>
  <Body>
    <HotelAvailRQ destination="CUN" checkin="2026-12-01" checkout="2026-12-05">
      <Occupancy adults="2" children="0"/>
    </HotelAvailRQ>
  </Body>
</Envelope>
```

`checkin` / `checkout`: `YYYY-MM-DD`. Max 30 nights. One room per request.

```bash
curl -X POST http://localhost:4003/gds -H 'Content-Type: text/xml' --data '<Envelope><Header><Credentials user="trama" password="demo"/></Header><Body><HotelAvailRQ destination="CUN" checkin="2026-12-01" checkout="2026-12-05"><Occupancy adults="2" children="0"/></HotelAvailRQ></Body></Envelope>'
```

### Response

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="urn:legacygds:v1">
<Body>
<HotelAvailRS destination="CUN" checkin="2026-12-01" checkout="2026-12-05" currency="USD" count="2">
  <Property code="CUN00003" name="HTL PLAYA DELFINES" category="2" addr="AV. BONAMPAK 1189">
    <Rate room="STE" plan="BB" nightly="172.97" maxPax="2" refundable="N"/>
    <Rate room="DBL" plan="BB" nightly="82.37" maxPax="2" refundable="Y"/>
  </Property>
  <Property code="CUN00012" name="RST PUERTO JUAREZ" category="4" addr="AV. BONAMPAK 1225">
    <Rate room="DBL" plan="AI" nightly="272.09" maxPax="2" refundable="Y"/>
  </Property>
</HotelAvailRS>
</Body>
</Envelope>
```

| Element / attr       | Description                                         |
|----------------------|-----------------------------------------------------|
| `Property@code`      | LegacyGDS property code (`<DEST><5 digits>`).        |
| `Property@name`      | Property name.                                      |
| `Property@category`  | Star category, 1-5.                                 |
| `Property@addr`      | Street address.                                     |
| `Rate@room`          | `SGL` `DBL` `TWN` `TPL` `FAM` `STE`                 |
| `Rate@plan`          | `RO` `BB` `HB` `FB` `AI`                             |
| `Rate@nightly`       | Nightly net rate in USD. Multiply by nights.        |
| `Rate@maxPax`        | Max occupancy.                                      |
| `Rate@refundable`    | `Y` / `N`                                           |

Properties with no availability are not returned.

## 4. Taxes

Rates do not include taxes. Apply the following per destination:

| Dest | Tax          | Per room / night |
|------|--------------|------------------|
| BRC  | 21 %         | USD 2.50         |
| MDZ  | 21 %         | -                |
| SLA  | 21 %         | USD 1.50         |
| FLN  | 5 %          | -                |
| CUN  | 16 %         | -                |

`total = nightly * nights * (1 + tax) + perNight * nights`

The current table can also be obtained with `HotelTaxRQ`:

```xml
<Envelope><Header><Credentials user="trama" password="demo"/></Header><Body><HotelTaxRQ/></Body></Envelope>
```

```xml
<HotelTaxRS>
  <Tax destination="BRC" pct="21.0" perNight="2.50" cur="USD"/>
  ...
</HotelTaxRS>
```

## 5. Errors

Processing errors are returned with `HTTP 500` and a `Fault` element:

```xml
<Envelope><Body><Fault><Code>GDS-422</Code><Message>Unknown destination</Message></Fault></Body></Envelope>
```

| Code    | Meaning                         |
|---------|---------------------------------|
| GDS-401 | Invalid credentials             |
| GDS-422 | Invalid request data            |
| GDS-429 | Throughput exceeded             |
| GDS-503 | Host unavailable, retry later   |
