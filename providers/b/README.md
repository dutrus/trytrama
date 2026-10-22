# SurBeds — Availability API v2

Integration guide for **SurBeds**, the leading bed bank in the Southern Cone.

> Local sandbox: `http://localhost:4002`
> Average response time: < 1 s. Availability SLA: 99.9%.

All amounts are expressed in **Argentine pesos (ARS)**. Dates are sent and returned in **DD/MM/YYYY** format.
Field names and codes are in Spanish.

---

## `GET /api/v2/ciudades`

Lists enabled cities.

```json
{
  "estado": "ok",
  "data": [
    { "id_ciudad": 1, "nombre": "San Carlos de Bariloche", "pais": "AR" },
    { "id_ciudad": 2, "nombre": "Mendoza", "pais": "AR" },
    { "id_ciudad": 3, "nombre": "Salta", "pais": "AR" },
    { "id_ciudad": 7, "nombre": "Florianópolis", "pais": "BR" },
    { "id_ciudad": 12, "nombre": "Cancún", "pais": "MX" }
  ]
}
```

## `GET /api/v2/cotizacion`

USD → ARS exchange rate for the current day. Updated once a day.

```json
{
  "estado": "ok",
  "data": { "moneda_origen": "USD", "moneda_destino": "ARS", "tipo_cambio": "1.204,37", "fecha": "20/10/2026" }
}
```

## `GET /api/v2/disponibilidad`

### Parameters

| Parameter       | Type   | Req.   | Description                                          |
|-----------------|--------|--------|------------------------------------------------------|
| `ciudad_id`     | int    | yes    | `id_ciudad` from `/api/v2/ciudades`.                 |
| `fecha_ingreso` | string | yes    | `DD/MM/YYYY`                                         |
| `fecha_egreso`  | string | yes    | `DD/MM/YYYY`. Max 30 nights.                         |
| `adultos`       | int    | no     | Default 2.                                           |
| `menores`       | int    | no     | Default 0.                                           |
| `limite`        | int    | no     | Results per page. Default 20, max 50.                |
| `cursor`        | string | no     | Value of `paginacion.siguiente_cursor` from the previous page. |

### Example

```bash
curl 'http://localhost:4002/api/v2/disponibilidad?ciudad_id=1&fecha_ingreso=01/12/2026&fecha_egreso=05/12/2026&adultos=2'
```

```json
{
  "estado": "ok",
  "data": {
    "busqueda": { "ciudad_id": 1, "fecha_ingreso": "01/12/2026", "fecha_egreso": "05/12/2026", "adultos": 2, "menores": 0 },
    "hoteles": [
      {
        "id_hotel": 80355,
        "nombre": "Apart Catedral - Bariloche",
        "categoria": "4*",
        "ubicacion": {
          "direccion": "Elflein 160",
          "ciudad": "San Carlos de Bariloche",
          "coordenadas": { "lat": "-41.1667", "lon": "-71.3643" }
        },
        "habitaciones": [
          {
            "codigo_habitacion": "DBL",
            "descripcion": "Doble estándar",
            "regimen": "desayuno",
            "capacidad_max": 2,
            "tarifa": {
              "moneda": "ARS",
              "precio_total": "939.074,67",
              "impuestos_incluidos": true,
              "politica": "reembolsable"
            }
          }
        ]
      }
    ]
  },
  "paginacion": {
    "siguiente_cursor": "eyJvIjoyMCwiaCI6MTIzNH0",
    "total_aproximado": 23
  }
}
```

### Fields

| Field                               | Type   | Description                                                      |
|-------------------------------------|--------|------------------------------------------------------------------|
| `id_hotel`                          | int    | SurBeds identifier.                                              |
| `nombre`                            | string |                                                                  |
| `categoria`                         | string | Star rating, format `"N*"` (e.g. `"4*"`).                       |
| `ubicacion.coordenadas.lat` / `lon` | number | Latitude / longitude.                                            |
| `habitaciones[].regimen`            | enum   | `solo_alojamiento`, `desayuno`, `media_pension`, `pension_completa`. |
| `tarifa.precio_total`               | string | Total price for the stay, format `1.234.567,89`.                 |
| `tarifa.impuestos_incluidos`        | bool   | In v2, prices always include taxes.                              |
| `tarifa.politica`                   | enum   | `reembolsable`, `no_reembolsable`.                               |
| `paginacion.siguiente_cursor`       | string | `null` on the last page.                                         |
| `paginacion.total_aproximado`       | int    | Estimated number of hotels for the search.                       |

### Pagination

Results are sorted by relevance. To get the next page, repeat the **same** search adding `cursor`. A cursor from a different search returns `400 CURSOR_INVALIDO`.

## Errors

```json
{ "estado": "error", "codigo": "PARAMETROS_INVALIDOS", "detalle": "ciudad_id inexistente" }
```

| HTTP | `codigo`               |
|------|------------------------|
| 400  | `PARAMETROS_INVALIDOS` |
| 400  | `CURSOR_INVALIDO`      |
| 404  | `RECURSO_INEXISTENTE`  |

For any issue, contact integraciones@surbeds.example.
