# Design

# Design

<!-- 1–3 pages. Bullets are fine. Tell us what you decided, why, and which alternatives you discarded.
     A simple diagram of how a search flows (Mermaid or ASCII) is welcome but optional. -->

```
Cliente (agente de viajes o agente de IA)
        |  GET /search  (SSE)
        v
   Entrada: valida parámetros, abre el stream
        |
   Orquestador: lanza A, B y C en paralelo, cada uno con su timeout
        |
   +----+-----+-----+
   |          |         |
 Adaptador  Adaptador  Adaptador     (llaman, parsean, pasan el precio a USD total)
   A          B         C
   |          |         |
   +----+-----+-----+
        |
   Dedup y merge: une el mismo hotel de distintos proveedores
        |
   Eventos SSE: search_started, hotel, offer, provider_status, done
```

## Schema and events

<!-- What is a "hotel" and what is an "offer" in your model? How do you represent price, currency,
     taxes, board type, cancellation/refundability?
     What events does /search stream, and what does a client do with each one? -->

Un **hotel** tiene id propio y estable, nombre, estrellas, dirección, coordenadas y una lista de ofertas. Estrellas y coordenadas pueden ser `null`: A omite las estrellas en algunos hoteles (su manual dice que son obligatorias) y C no trae coordenadas. Prefiero un `null` explícito a inventar un valor.

Una **oferta** tiene proveedor, habitación, régimen (RO, BB, HB, FB, AI), capacidad, reembolsable (`true`, `false` o `null` si el proveedor no lo informó) y precio total en USD por toda la estadía, con impuestos incluidos.

**Cómo llego a un precio comparable:**
- **A:** ya viene en USD y por la estadía. Su manual dice que "pueden aplicar impuestos en la propiedad". Asumo que están incluidos porque la Twin de Cabañas Cerro Otto cuesta 766,10 en A y 753,04 en C con impuestos. Es una suposición, no una certeza.
- **B:** viene en ARS, con formato argentino ("1.234.567,89"). Si `impuestos_incluidos` es `false` (el manual dice que siempre es `true`), le sumo `impuestos`. Convierto con la cotización del día.
- **C:** viene neto por noche. Calculo `nightly * noches * (1 + pct) + perNight * noches`. Pido la tabla de impuestos con `HotelTaxRQ` porque la del manual no coincide con la real (Cancún: manual 16%, real 19% más USD 4,50 por noche).

**Eventos del stream:**

| Evento | Cuándo | Qué hace el cliente |
|---|---|---|
| `search_started` | Al arrancar | Muestra qué proveedores se consultan |
| `hotel` | Llega un hotel nuevo | Agrega una fila |
| `offer` | Oferta tardía de un hotel ya mostrado | La agrega a esa fila |
| `provider_status` | Cambia el estado de un proveedor | Actualiza el aviso ("B reintentando") |
| `done` | Terminaron todos o venció el tope | Cierra e informa qué proveedores faltaron y por qué |

## Deduplication

<!-- How do you decide that two results are the same hotel, when they arrive at different times?
     Include at least one concrete example where it gets it wrong. -->

Cada hotel que llega se compara contra los ya emitidos, con 5 señales: nombre parecido, misma calle, mismo número, mismas estrellas y coordenadas a menos de unos 150 m (solo si las dos partes las tienen). Se unen con 4 de 5 y sin contradicciones duras (estrellas distintas o coordenadas lejanas). C no trae coordenadas, así que con C se exigen 4 de 4. Como los proveedores contestan en momentos distintos, la comparación corre cada vez que llega un proveedor nuevo: si se une, sale un `offer`; si no, un `hotel`.

Antes de comparar normalizo: minúsculas, sin tildes, abreviaturas de C expandidas (CAB, APT, HTL, BTQ, RST), sufijos de ciudad fuera (" - Bariloche") y direcciones normalizadas.

**Ante la duda no uno**, y el hotel sale con una nota que explica a qué se parecía y por qué no se unió. Elegí ese lado porque unir dos hoteles distintos le muestra a la clienta un precio que no corresponde a ese hotel, y un duplicado solo molesta.

Con datos reales, por ejemplo: Cabañas Cerro Otto (A) y CAB CERRO OTTO (C), mismo número y calle, se unen. "Hotel Colonia Suiza" (A, Moreno 233) y "CAB COLONIA SUIZA" (C, Pioneros 682) comparten nombre pero no dirección, y quedan separados.

**Dónde se equivoca:** PENDIENTE. Lo saco corriendo los tres proveedores y listando los pares que casi se unen.

## Boundaries / adapters

<!-- Where does "the provider" end and "your domain" begin? What does an adapter do and not do?
     What would it take to add a fourth provider? -->

El adaptador es la frontera. Llama al proveedor, parsea su formato y devuelve hoteles y ofertas en el formato común, con el precio ya en USD. Todo lo raro de un proveedor (fechas, formatos numéricos, impuestos, errores) se queda adentro. No deduplica, no cachea búsquedas y no decide cuándo termina la búsqueda.

Para sumar un cuarto proveedor: un archivo con su adaptador y registrarlo en la lista de proveedores. El resto del sistema no cambia.

## Latency, streaming and caching

<!-- How do you get the first event out fast with providers that take 3 s? When do you send `done`?
     What do you cache, for how long, and how stale can a price be?
     Paste your `bun run load` results. -->

Los tres proveedores se consultan en paralelo y cada resultado sale por el stream apenas llega. A responde en 150 a 400 ms, así que el primer evento sale rápido sin esperar a B ni a C.

**Cuándo mando `done`:** espero hasta un tope de unos 5,5 s (PENDIENTE confirmar con `bun run load`). Prioricé completitud sobre rapidez: una agente pierde más si se pierde la mejor tarifa que si espera un poco más, y mientras tanto ya ve resultados y avisos de qué falta. Descarté un tope de 1,5 s: sería más rápido, pero casi siempre perdería a C.

| Qué se guarda | Cuánto | Por qué |
|---|---|---|
| Búsqueda completa | 1 a 2 minutos | El precio es indicativo; se confirma al reservar |
| Cotización de B | Hasta que cambie el día | El manual dice que se actualiza una vez al día |
| Tabla de impuestos de C | 1 hora | Cambia poco y C tiene límite de pedidos |
| Búsquedas con un proveedor caído | No se guardan | Para no repetir una falla |

**Resultados de `bun run load`:** PENDIENTE.

## Failures

<!-- Timeouts, retries, rate limits, weird responses. What does the client see when a provider fails? -->

Cada proveedor falla por separado y ninguna falla tumba la búsqueda.
- **A:** un reintento ante un 500.
- **B:** el 5% de las veces nunca responde. Reintenta una vez por detrás mientras el stream sigue abierto.
- **C:** respeta `Retry-After` si cabe dentro del tope; si no, informa `rate_limited`.

El cliente ve un `provider_status` por proveedor (`ok`, `retrying`, `timeout`, `error`, `rate_limited`) y el `done` resume qué faltó y por qué. Reintentar es seguro porque una búsqueda no cambia nada en el proveedor.

## Agent

<!-- Which LLM/model and why. What does the search tool return to the model (and what doesn't it)?
     How does it stay grounded? What does it do with partial results and missing information?
     How did you test it? -->

**Modelo:** `gemini-3.5-flash`. Tiene capa gratuita sin tarjeta, soporta llamar herramientas (lo comprobé con una prueba) y alcanza para una sola herramienta con parámetros simples. Probé antes `gemini-2.5-flash` (ya no está disponible para cuentas nuevas) y `gemini-3.8-flash` (503 por demanda). El modelo se configura por variable de entorno y queda detrás de una capa chica, para cambiar de proveedor tocando un solo archivo. Con 503 y 429 el agente reintenta y, si sigue fallando, avisa en vez de romperse. Alternativas que consideré: Groq (más rápido, solo modelos abiertos) y DeepSeek (requiere saldo).

**Qué hace:** conversacional en la terminal. La herramienta `search_hotels` acepta solo los 5 destinos válidos (el modelo devolvió "Bariloche" con mayúscula en la prueba) y llama a mi `/search` por HTTP. Al modelo le devuelve datos compactos: hoteles, precio total en USD, régimen, reembolsable y el estado de cada proveedor. Los mensajes del modelo se guardan enteros en el historial (Gemini 3 devuelve una `thoughtSignature` que hay que reenviar); solo se compactan los resultados de búsqueda.

**Información que falta:** si faltan las fechas, pregunta todo lo que falta en un solo mensaje. Lo menor (adultos) se supone y se avisa.

**Fidelidad a los datos:** no confío solo en el prompt. Después de cada respuesta verifico en código que cada hotel y precio mencionado exista en el último resultado, y que se avise cuando un proveedor no respondió.

**Cómo lo probé:** PENDIENTE (casos fijos: pedido completo, sin fechas, "el finde que viene", un proveedor caído, destino inexistente).

## What I left out

<!-- What you'd do with more time, what production would need, debt you took on deliberately. -->

- **Ejecución durable:** el sistema solo consulta, así que repetir una búsqueda es seguro. Con reservas haría falta persistir estado e idempotency keys.
- **Varias instancias:** el límite de 5 pedidos por segundo de C es global. Con más de una copia de la API habría que compartir ese contador.
- **Confirmación de precio al reservar:** el precio mostrado es indicativo.
- **Dedup perfecto:** con estos datos no es posible.
- **Datos que la agente debería pedir antes de buscar** (destino, fechas, personas): hoy lo resuelve el agente preguntando.
- PENDIENTE: lo que no llegue a hacer.

## AI usage

<!-- Short summary: what you used it for, where it helped, where it got things wrong and how you noticed.
     Details go in AI_LOG.md. -->

Usé Claude en el chat para entender el problema y tomar las decisiones de diseño, y Claude Code para escribir el código con mi aprobación en cada paso. Dos casos donde falló o no coincidía con la realidad: el primer modelo de Gemini que probé ya no estaba disponible (lo noté por un 404 al probarlo), y el script de prueba hacía fallar `bun typecheck` en el CI (lo detectó Claude Code al revisar). PENDIENTE: completar con lo que ocurra al construir. Detalle en `AI_LOG.md`.