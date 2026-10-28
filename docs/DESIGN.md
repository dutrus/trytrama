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
   Orquestador: lanza A, B y C en paralelo, con un tope común de 5,5 s
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

Una **oferta** tiene proveedor, tipo de habitación, nombre de la habitación, régimen (RO, BB, HB, FB, AI), capacidad, reembolsable (`true`, `false` o `null` si el proveedor no lo informó) y precio total en USD por toda la estadía, con impuestos incluidos. El tipo de habitación (`roomType`) es un código común: SGL, DBL, TWN, TPL, FAM o STE. Los tres proveedores usan ese mismo conjunto (A como prefijo de `roomCode`, B en `codigo_habitacion`, C en `room`); lo verifiqué con datos reales, y si llega otro código queda `null`. El nombre (`roomName`) se guarda tal cual lo manda cada proveedor, porque viene en tres estilos: inglés en A ("Twin Standard - Bed & breakfast"), español en B ("Doble twin") y solo el código en C ("TWN").

**Cómo llego a un precio comparable:**
- **A:** ya viene en USD y por la estadía. Su manual dice que "pueden aplicar impuestos en la propiedad". Asumo que están incluidos porque la Twin de Cabañas Cerro Otto cuesta 766,10 en A y 753,04 en C con impuestos. Hay otra evidencia, débil: en 187 habitaciones iguales (mismo hotel, código y régimen) de A y B, la diferencia de precio mediana es 7,9% (máxima 18,3%), cuando los impuestos de estos destinos van del 5% al 21%. Es débil porque los proveedores también varían el precio entre sí. Es una suposición, no una certeza.
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

Cada hotel que llega se compara contra cada fuente de los hoteles ya emitidos:
- **Núcleo:** misma calle, mismo número y mismo nombre. Los tres tienen que coincidir.
- **Nombre exacto** (las mismas palabras en cualquier orden, después de normalizar): alcanza con el núcleo.
- **Nombre por tolerancia** (un nombre de C cortado a 24 caracteres): además hace falta un refuerzo presente en los dos y coincidente, es decir, mismas estrellas o coordenadas a 150 m o menos.
- Un refuerzo presente que se contradice (estrellas distintas, coordenadas a más de 150 m) impide la unión; uno ausente no cuenta ni a favor ni en contra.
- Nunca se unen dos hoteles del mismo proveedor, y si dos hoteles ya emitidos califican (empate), no se une con ninguno.

Como los proveedores contestan en momentos distintos, la comparación corre cada vez que llega un proveedor: si se une, sale un `offer`; si no, un `hotel`.

Antes de comparar normalizo: minúsculas, sin tildes ni signos, abreviaturas de C expandidas (CAB, APT, HTL, BTQ, RST, entre otras), sufijo de ciudad fuera (" - Bariloche") y direcciones separadas en calle y número ("avenida" → "av").

**Ante la duda no uno**, y el hotel sale con una nota (`matchNote`) en cuatro situaciones: mismo nombre por tolerancia y misma dirección pero sin refuerzo, un refuerzo que se contradice, misma dirección con otro nombre, y empate. Si solo coincide parte del nombre no hay nota: el catálogo repite nombres con otro tipo y otra dirección (Hotel, Lodge y Apart Catedral), y serían decenas de notas por destino. Elegí no unir ante la duda porque unir dos hoteles distintos le muestra a la clienta un precio que no corresponde a ese hotel, y un duplicado solo molesta. La excepción es el nombre exacto con la misma dirección: ahí uno sin pedir refuerzo (abajo, por qué y qué riesgo trae).

Con datos reales, por ejemplo: Cabañas Cerro Otto (A) y CAB CERRO OTTO (C), mismo nombre, calle y número, se unen. "Hotel Colonia Suiza" (A, Moreno 233) y "CAB COLONIA SUIZA" (C, Pioneros 682) solo comparten "Colonia Suiza": el tipo y la dirección son otros, así que quedan separados y sin nota.

**Dónde se equivoca:**

**Medición.** Comparé el resultado contra el catálogo del simulador (`packages/mock-kit`, leído solo desde un script fuera del repo): 6 estadías en los 5 destinos y 3 órdenes de llegada. Dio 585 filas, que son los 195 hoteles reales en cada uno de los 3 órdenes, con 0 uniones erróneas y 0 hoteles separados. Para comprobar que la medición detecta errores, rompí la regla a propósito (unir solo por dirección, sin revisar contradicciones) y reportó 3 uniones erróneas. Ignorar solo la calle o solo el nombre no produjo errores con estos datos: esas comprobaciones las cubren tests unitarios, no la medición. El resultado es tan bueno porque el simulador escribe la misma dirección en los tres proveedores y no repite nombres dentro de un destino; con datos reales no lo esperaría.

**La regla anterior (Los Coihues).** La primera versión siempre exigía estrellas o coordenadas que confirmaran la unión. Así, "Boutique Hotel Los Coihues - Bariloche" (B, categoría "Boutique", sin estrellas) y "BTQ HTL LOS COIHUES" (C, sin coordenadas), los dos en Elflein 1567, quedaban separados porque no había nada con qué confirmar. Medido contra el catálogo, eran 9 pares del mismo hotel separados, todos con el nombre exacto. Por eso hoy alcanzan el nombre exacto, la calle y el número, y el refuerzo solo se exige cuando el nombre coincide por tolerancia.

**Casos construidos** (no aparecen en los datos; cada uno tiene su test):
- *Dos hoteles distintos con el mismo nombre y la misma dirección se unen.* Es el error caro, porque muestra el precio de otro hotel. Pasa porque con nombre exacto no pido refuerzo y un refuerzo ausente no cuenta en contra: si uno de los proveedores no manda estrellas ni coordenadas, nada los distingue. Lo acepto porque exigir refuerzo separaba 9 pares reales del mismo hotel, y en los datos no hay ningún nombre con dirección repetidos.
- *Empate por orden de llegada:* si B y C traen el mismo hotel sin poder confirmarse entre sí (B sin estrellas, C con el nombre truncado) y después llega A, que coincide con los dos, no se une con ninguno y el hotel aparece tres veces. La mejora sería un evento para fusionar filas ya enviadas.
- *Dirección escrita distinto:* "Av. Bustillo km 8,5" y "Av. Bustillo 8500" no se reconocen como la misma dirección; el hotel queda duplicado y sin nota.
- *Nombre con palabras de más:* "Panamericano Hotel" y "Panamericano Hotel & Spa" en la misma dirección no se unen; el segundo sale con la nota "misma dirección con otro nombre".

## Boundaries / adapters

<!-- Where does "the provider" end and "your domain" begin? What does an adapter do and not do?
     What would it take to add a fourth provider? -->

El adaptador es la frontera. Llama al proveedor, parsea su formato y devuelve hoteles y ofertas en el formato común, con el precio ya en USD. Todo lo raro de un proveedor (fechas, formatos numéricos, impuestos, errores) se queda adentro. No deduplica, no cachea búsquedas y no decide cuándo termina la búsqueda.

Para sumar un cuarto proveedor: un archivo con su adaptador y registrarlo en la lista de proveedores. El resto del sistema no cambia.

**C habla XML** y lo leo con un parser propio de unas 30 líneas (expresiones regulares sobre elementos y atributos, más las entidades XML como `&amp;`) en vez de una dependencia como `fast-xml-parser`. La respuesta de C es plana y casi todo viene en atributos, así que una librería sumaba peso sin resolver nada que esto no cubra. No soporta CDATA, comentarios ni prefijos de namespace: si C empezara a usarlos, el adaptador no reconoce la respuesta y falla con error, en vez de devolver datos inventados.

## Latency, streaming and caching

<!-- How do you get the first event out fast with providers that take 3 s? When do you send `done`?
     What do you cache, for how long, and how stale can a price be?
     Paste your `bun run load` results. -->

Los tres proveedores se consultan en paralelo y el resultado de cada uno sale por el stream apenas llega. B entrega todos sus hoteles juntos, al terminar sus páginas, no página por página. A responde en 150 a 400 ms, así que el primer evento sale rápido sin esperar a B ni a C.

B es el más lento: cada página tarda de 0,8 a 2,5 s y van una tras otra, así que con dos páginas puede llegar a unos 5 s. Si además una página necesita el segundo pedido, puede vencer el tope y B queda incompleto. C pasa por un limitador propio de 5 pedidos por segundo con ráfaga de 4, no de 5 como el servidor: el primer pedido también abre la conexión y le llega a C más tarde de lo que lo contamos, y con ráfaga de 5 el sexto pedido llegaba antes de tiempo y recibía un 429. Con ráfaga de 4 queda un turno de margen sin bajar la tasa.

**Cuándo mando `done`:** cuando terminaron los tres proveedores o a los 5,5 s, lo que pase primero. La medición lo confirma: el tope cubre a B en la gran mayoría de los casos, y en cerca del 6,5% de las búsquedas B queda incompleto y se avisa (`partial` o `timeout`). Un tope menor lo perdería más seguido. Prioricé completitud sobre rapidez: una agente pierde más si se pierde la mejor tarifa que si espera un poco más, y mientras tanto ya ve resultados y avisos de qué falta. Descarté un tope de 1,5 s: sería más rápido, pero casi siempre perdería a C.

| Qué se guarda | Cuánto | Por qué |
|---|---|---|
| Búsqueda completa | 90 s | El precio es indicativo; se confirma al reservar |
| Cotización de B | Hasta que cambie el día | El manual dice que se actualiza una vez al día |
| Tabla de impuestos de C | 1 hora | Cambia poco y C tiene límite de pedidos |
| Búsquedas con un proveedor caído | No se guardan | Para no repetir una falla |

**Resultados de `bun run load`** (200 búsquedas, 10 a la vez, chaos activo con `CHAOS_SEED=ci`, `bun dev` reiniciado antes de cada medición). La caché de búsquedas completas dura 90 s y es solo para búsquedas en las que los tres proveedores terminaron en `ok`; un acierto repite los eventos con `cached: true`.

| Medición | Sin caché (p50 / p95 / p99) | Con caché (p50 / p95 / p99) |
|---|---|---|
| Primer evento (`search_started`) | 1 / 5 / 7 ms | 1 / 5 / 7 ms |
| Primer hotel (`firstHotelMs`) | 263 / 401 / 628 ms | 0 / 374 / 467 ms |
| `done` | 3025 / 5504 / 5513 ms | 2 / 4948 / 5513 ms |
| Aciertos de caché | — | 104 de 200 |
| Búsquedas completas | 186 de 200 | 196 de 200 |
| Duración de la corrida | 65,4 s | 34,2 s |
| Tasa de error | 0,00% | 0,00% |

Primer evento y `done` salen de `bun run load`. Primer hotel, aciertos y búsquedas completas salen de un script aparte con la misma mezcla de tráfico, que lee el `done` de cada búsqueda. Con caché, el primer hotel de las 96 búsquedas en vivo da 262 / 433 / 695 ms.

- **El primer evento sale a los pocos ms porque es `search_started`**, que se manda apenas se abre el stream y no depende de ningún proveedor. Por eso reporto también el primer hotel: es lo que de verdad ve la agente, viene de A y llega con p95 de unos 400 ms.
- **El `done` p95 coincide con el tope** porque, sin caché, 13 de 200 búsquedas (6,5%) lo alcanzan, todas por B: pagina de a 20, las páginas van una tras otra y, si una necesita el pedido de cobertura, no llega. En esas búsquedas B termina en `partial` (11) o `timeout` (2).
- **La caché mejora el p50 del `done`** (de 3 s a 2 ms, porque el 60% del tráfico repite 10 búsquedas) **pero casi no el p99** (5,5 s en los dos casos): las búsquedas nuevas siguen esperando a B. Había estimado p50 de unos 5 ms, p95 de unos 4,7 s y 103 aciertos, y la medición dio 2 ms, 4,9 s y 104.

## Failures

<!-- Timeouts, retries, rate limits, weird responses. What does the client see when a provider fails? -->

Cada proveedor falla por separado y ninguna falla tumba la búsqueda.
- **A:** un reintento ante un 5xx.
- **B:** el 5% de las veces nunca responde. Si un pedido (una página o la cotización) no contesta en 2,6 s, que es el máximo normal de B, lanzo un segundo pedido igual sin cancelar el primero y uso el que llegue antes; el cliente ve `retrying`. Además B pagina de a 20 aunque se pida `limite=50`, y casi todos los destinos tienen dos páginas: si una página intermedia falla, o vence el tope entre páginas, el adaptador devuelve los hoteles que ya llegaron marcados como incompletos (`PartialResultError`) en vez de descartarlos.
- **C:** ante un 429 espera `Retry-After` sin revisar si cabe dentro del tope, porque el adaptador no conoce el tope: si la búsqueda se cancela mientras espera, informa `rate_limited`. Ante un GDS-503 (que C devuelve como `<Fault>` dentro de un HTTP 200) reintenta una vez.

El cliente ve un `provider_status` por proveedor (`ok`, `partial`, `retrying`, `timeout`, `error`, `rate_limited`) y el `done` resume qué faltó y por qué, con la lista `missing`. "B incompleto" es el estado `partial`: los hoteles que llegaron se muestran igual, y el estado dice cuántos llegaron y por qué se cortó (`timeout` si venció el tope entre páginas, `error` si falló una página). Reintentar es seguro porque una búsqueda no cambia nada en el proveedor.

## Agent

<!-- Which LLM/model and why. What does the search tool return to the model (and what doesn't it)?
     How does it stay grounded? What does it do with partial results and missing information?
     How did you test it? -->

**Modelo:** `gemini-3.5-flash`. Tiene capa gratuita sin tarjeta, soporta llamar herramientas (lo comprobé con una prueba) y alcanza para una sola herramienta con parámetros simples. Probé antes `gemini-2.5-flash` (ya no está disponible para cuentas nuevas) y `gemini-3.8-flash` (503 por demanda). El modelo se configura con `GEMINI_MODEL` y queda detrás de una capa chica (`llm.ts`, `fetch` directo, sin SDK), para cambiar de proveedor tocando un solo archivo. Alternativas que consideré: Groq (más rápido, solo modelos abiertos) y DeepSeek (requiere saldo). **Límite real de la capa gratuita:** se agotó con pocas decenas de pedidos en una sesión de desarrollo (evals y pruebas); después Gemini respondió 429 pidiendo esperar unos 55 minutos.

**Reintentos y fallas de Gemini:** ante 503 o 429 reintenta hasta 3 veces, esperando lo que pide Gemini o 1, 2 y 4 s, y avisa cada reintento ("Gemini ocupado, reintento en 1 s…"). Nunca espera más de 20 s: si la cuota pide más, falla en el momento con un mensaje claro. Antes de ese límite, una cuota agotada dejaba el CLI 55 minutos en silencio y parecía colgado. Si el modelo devuelve una respuesta vacía (sin texto ni llamada a la herramienta), avisa y reintenta una vez; si se repite, mensaje claro. Mientras espera al modelo muestra "Pensando…". La clave nunca aparece en mensajes ni logs.

**Qué hace:** conversacional en la terminal (`bun agent "…"`; con la entrada redirigida, cada línea es un mensaje más). La herramienta `search_hotels` acepta solo los 5 destinos (lista cerrada, normalizada a minúsculas: el modelo devolvió "Bariloche" en la prueba) y llama a mi `/search` por HTTP, leyendo el SSE a medida que llega para mostrar el progreso de cada proveedor. Al modelo le devuelve datos compactos:
- **Por hotel:** nombre, estrellas, `matchNote` si existe y sus 3 ofertas más baratas, con cuántas más hay.
- **Por oferta:** precio total en USD, habitación, régimen, reembolsable y proveedor. La habitación sale de `roomType` en español (Single, Doble, Doble twin, Triple, Familiar, Suite), así no aparece en tres estilos.
- **De la búsqueda:** el estado de cada proveedor (con `partial` y su motivo), `missing` y `cached`.
- **Lo que no le pasa:** direcciones, coordenadas ni tiempos.

Un 400 de la API vuelve al modelo como error de la herramienta; si la API no está levantada, el CLI lo dice sin traza. Los mensajes del modelo se guardan enteros en el historial (Gemini 3 devuelve una `thoughtSignature` que hay que reenviar); solo se compactan los resultados de búsquedas anteriores, que quedan como un resumen de una línea.

**Información que falta:** si faltan datos, pregunta todo en un solo mensaje. Las fechas siempre se preguntan; los adultos se suponen en 2 y se avisa. La fecha de hoy (hora de Argentina) va en las instrucciones. **Supuesto de "el finde que viene":** del viernes al domingo del próximo fin de semana (si hoy ya es viernes, sábado o domingo, el siguiente), y el agente dice qué fechas usó. Un destino fuera de la lista no se busca: dice cuáles hay.

**Fidelidad a los datos:** no confío solo en el prompt. Después de cada respuesta, `grounding.ts` verifica en código que cada precio en USD coincida con una oferta del último resultado, que cada nombre de hotel exista en él y que se mencione cada proveedor de `missing`. Si falla, avisa y le pide al modelo **una** corrección (el texto ya salió por streaming, así que no se puede borrar). Además, el estado de los proveedores y el aviso de caché los imprime el código al final, así no dependen del modelo.

**Qué no detecta la verificación** (es heurística sobre texto libre):
- Un precio escrito sin marca de moneda ("cuesta 753") o en palabras.
- Un precio que existe pero atribuido a otro hotel o a otra habitación: compara contra todas las ofertas, no hotel por hotel.
- Un nombre de hotel sin palabra de tipo ("el Cerro Otto") o en minúsculas; en cambio, un nombre parcial de uno real pasa ("Hotel Cerro" coincide con "Hotel Cerro Otto").
- Datos falsos que no son nombres ni precios: régimen, reembolsable, estrellas, fechas.
- Que se mencione un proveedor faltante sin decir bien qué le pasó: solo busca la letra cerca de palabras como "no respondió" o "proveedor".

**Cómo lo probé:**
- **Tests sin red (`bun test`)**, con un modelo falso:
  - la herramienta y el historial (partes enteras, compactación);
  - la verificación;
  - los reintentos, el límite de 20 s y la respuesta vacía;
  - una conversación con una lista fija de mensajes.
- **Modo interactivo** del CLI, probado a mano con un pseudo-terminal y un Gemini falso:
  - las líneas escritas mientras el modelo responde quedan en cola;
  - el prompt aparece solo al terminar el turno;
  - el 503, la respuesta vacía y la cuota agotada muestran su aviso.
- **Evals con Gemini real** (`evals.ts`, fecha de hoy fija en el miércoles 28/10/2026):
  - **Pasaron:** 1, pedido completo (busca con los parámetros correctos y pasa la verificación); 2, sin fechas (no busca y pregunta las fechas); 3, "el finde que viene" (busca del 30/10 al 1/11 y lo dice); 4, un proveedor caído (avisa que B no respondió y pasa la verificación). El eval 4 usa un **resultado de búsqueda simulado** en el que falta B: prueba cómo el modelo maneja un proveedor faltante, no la cadena completa.
  - **PENDIENTE:** el eval 5, destino inexistente. Lo cortó la cuota agotada.
  - Los 4 que pasaron corrieron antes del arreglo del CLI y de los reintentos. PENDIENTE: volver a correr los 5 con el código actual.

## What I left out

<!-- What you'd do with more time, what production would need, debt you took on deliberately. -->

- **Ejecución durable:** el sistema solo consulta, así que repetir una búsqueda es seguro. Con reservas haría falta persistir estado e idempotency keys.
- **Varias instancias:** el límite de 5 pedidos por segundo de C es global. Con más de una copia de la API habría que compartir ese contador.
- **Confirmación de precio al reservar:** el precio mostrado es indicativo.
- **Dedup perfecto:** un dedup perfecto no está garantizado con proveedores reales; el 0 de errores medido es optimista por lo limpio del simulador.
- **Nombres abreviados de C:** cada fila muestra el nombre del proveedor que la creó, así que un hotel que solo tiene C, o que C trajo primero, aparece como "HTL CERRO OTTO" o "BTQ HTL VIRREYES". Mejoraría preferir el nombre de A o B cuando llegan después, o embellecer los de C (expandir abreviaturas, mayúsculas y minúsculas).
- **Evento para fusionar filas ya enviadas:** resolvería el empate por orden de llegada (ver "Dónde se equivoca"), a costa de que el cliente tenga que poder unir o quitar filas.
- **Subir el tope del `done`:** recuperaría parte de las búsquedas en que B queda incompleto, a costa de que todas las búsquedas nuevas en que B tarda esperen más.
- **Pedir las páginas de B en paralelo:** bajaría el tiempo de B, pero hoy no se puede, porque el cursor es opaco y cada página necesita el cursor de la anterior.
- **Coalescing de búsquedas idénticas en curso:** con esta carga solo se habrían unido 6 pedidos de 200, porque casi nunca coinciden dos iguales en el mismo momento. Si se agrega, la desconexión de un cliente no debe cancelar una búsqueda que otros siguen esperando.
- **Limpieza de la caché:** las entradas vencidas se borran solo cuando alguien vuelve a pedir esa búsqueda. En un servidor que corre mucho tiempo, las búsquedas que nadie repite quedan en memoria; haría falta una limpieza periódica o un tamaño máximo.
- **Datos que la agente debería pedir antes de buscar** (destino, fechas, personas): hoy lo resuelve el agente preguntando.
- **Fechas de "el finde que viene" calculadas en código:** hoy la regla vive solo en el prompt y la cuenta la hace el modelo. Con el mismo prompt, el eval 3 pasó una vez y falló otra (buscó del 6 al 8/11 en vez del 30/10 al 1/11). Calcular esas fechas en código y dárselas al modelo como dato quita esa variación.
- **Una oferta por línea:** en una corrida real, el modelo escribió "Doble (o Doble twin)" para un mismo hotel, mezclando dos ofertas en una línea. La verificación no lo detecta, porque solo controla precios, nombres de hotel y proveedores faltantes.
- PENDIENTE: lo que no llegue a hacer.

## AI usage

<!-- Short summary: what you used it for, where it helped, where it got things wrong and how you noticed.
     Details go in AI_LOG.md. -->

Usé Claude en el chat para entender el problema y tomar las decisiones de diseño, y Claude Code para escribir el código con mi aprobación en cada paso. Dos casos donde falló o no coincidía con la realidad: el primer modelo de Gemini que probé ya no estaba disponible (lo noté por un 404 al probarlo), y el script de prueba hacía fallar `bun typecheck` en el CI (lo detectó Claude Code al revisar). PENDIENTE: completar con lo que ocurra al construir. Detalle en `AI_LOG.md`.