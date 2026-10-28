# apps/agent: el agente

Agente de línea de comandos para agentes de viajes. Entiende un pedido en español o inglés, busca con la API `/search` (por HTTP, nunca directo a los proveedores) y responde en streaming, solo con hoteles y precios de la búsqueda.

```bash
bun agent "Bariloche, 4 noches desde el 10 de julio, 2 adultos, con desayuno"
```

En una terminal sigue la conversación hasta una línea vacía o Ctrl+C. Con la entrada redirigida, cada línea es un mensaje más:

```bash
printf 'Del 10 al 14 de enero, 2 adultos\n' | bun agent "Necesito hotel en Bariloche"
```

La API tiene que estar levantada (`bun dev`).

## Variables de entorno

| Variable | Para qué | Por defecto |
|---|---|---|
| `GEMINI_API_KEY` | Clave de Gemini. Va en `.env`, que no se commitea. | (obligatoria) |
| `GEMINI_MODEL` | Modelo de Gemini. | `gemini-3.5-flash` |
| `API_URL` | Dónde está la API de búsqueda. | `http://localhost:3000` |

## Pruebas

- `bun test`: tests sin red, con un modelo falso.
- `bun apps/agent/src/evals.ts`: 5 casos fijos con Gemini real (necesita la clave y `bun dev`).
