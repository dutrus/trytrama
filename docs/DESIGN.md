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

Los tres proveedores se consultan en paralelo y cada resultado sale por el stream apenas llega. A responde en 150 a 400 ms, así que el primer evento sale rápido sin esperar a B ni a C.

B es el más lento: cada página tarda de 0,8 a 2,5 s y van una tras otra, así que con dos páginas puede llegar a unos 5 s. Si además una página necesita el segundo pedido, puede vencer el tope y B queda incompleto. C pasa por un limitador propio de 5 pedidos por segundo con ráfaga de 4, no de 5 como el servidor: el primer pedido también abre la conexión y le llega a C más tarde de lo que lo contamos, y con ráfaga de 5 el sexto pedido llegaba antes de tiempo y recibía un 429. Con ráfaga de 4 queda un turno de margen sin bajar la tasa.

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
- **A:** un reintento ante un 5xx.
- **B:** el 5% de las veces nunca responde. Si un pedido (una página o la cotización) no contesta en 2,6 s, que es el máximo normal de B, lanzo un segundo pedido igual sin cancelar el primero y uso el que llegue antes; el cliente ve `retrying`. Además B pagina de a 20 aunque se pida `limite=50`, y casi todos los destinos tienen dos páginas: si una página intermedia falla, o vence el tope entre páginas, el adaptador devuelve los hoteles que ya llegaron marcados como incompletos (`PartialResultError`) en vez de descartarlos.
- **C:** ante un 429 espera `Retry-After` sin revisar si cabe dentro del tope, porque el adaptador no conoce el tope: si la búsqueda se cancela mientras espera, informa `rate_limited`. Ante un GDS-503 (que C devuelve como `<Fault>` dentro de un HTTP 200) reintenta una vez.

El cliente ve un `provider_status` por proveedor (`ok`, `retrying`, `timeout`, `error`, `rate_limited`) y el `done` resume qué faltó y por qué. Cómo se muestra "B incompleto" (llegaron algunos hoteles y faltan otros) queda PENDIENTE para el paso 4: la lista de estados todavía no tiene uno para eso. Reintentar es seguro porque una búsqueda no cambia nada en el proveedor.

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
- **Dedup perfecto:** un dedup perfecto no está garantizado con proveedores reales; el 0 de errores medido es optimista por lo limpio del simulador.
- **Evento para fusionar filas ya enviadas:** resolvería el empate por orden de llegada (ver "Dónde se equivoca"), a costa de que el cliente tenga que poder unir o quitar filas.
- **Datos que la agente debería pedir antes de buscar** (destino, fechas, personas): hoy lo resuelve el agente preguntando.
- PENDIENTE: lo que no llegue a hacer.

## AI usage

<!-- Short summary: what you used it for, where it helped, where it got things wrong and how you noticed.
     Details go in AI_LOG.md. -->

Usé Claude en el chat para entender el problema y tomar las decisiones de diseño, y Claude Code para escribir el código con mi aprobación en cada paso. Dos casos donde falló o no coincidía con la realidad: el primer modelo de Gemini que probé ya no estaba disponible (lo noté por un 404 al probarlo), y el script de prueba hacía fallar `bun typecheck` en el CI (lo detectó Claude Code al revisar). PENDIENTE: completar con lo que ocurra al construir. Detalle en `AI_LOG.md`.