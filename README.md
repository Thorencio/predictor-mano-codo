# Predictor bayesiano de mano-muñeca y codo-antebrazo

Prototipo web que, con un solo ingreso de datos, estima la probabilidad de 19 diagnósticos frecuentes en **dos segmentos**: 11 de mano-muñeca y 8 de codo-antebrazo, a partir de anamnesis, examen físico, laboratorio e imágenes. Usa razones de verosimilitud (LR) de revisiones sistemáticas, guías y estudios diagnósticos, y sugiere qué evaluar a continuación.

> Prototipo en validación. No entrega diagnósticos ni reemplaza la evaluación de un profesional de salud.

## Estructura

```
public/                  ← lo que publica Vercel (sitio estático, sin build)
  index.html
  css/styles.css
  js/engine.js           ← motor bayesiano (sin dependencias, probado con tests)
  js/app.js              ← interfaz, modo revisión y validación de casos
  data/knowledge.json    ← BASE DE CONOCIMIENTO: lo que se revisa y corrige
tests/engine.test.js     ← pruebas del motor y de coherencia de la base
vercel.json              ← configuración de despliegue
```

## Publicar en Vercel

**Opción A, con GitHub (recomendada para trabajar con colegas):**

1. Crea un repositorio en GitHub y sube esta carpeta completa.
2. En [vercel.com](https://vercel.com), entra con tu cuenta de GitHub y elige **Add New → Project**.
3. Importa el repositorio. Framework Preset: **Other**. No cambies nada más; `vercel.json` ya indica que se publica la carpeta `public`.
4. Pulsa **Deploy**. Te dará una dirección del tipo `predictor-mano-codo.vercel.app`.

Desde ahí, cada cambio que subas a GitHub se publica solo. Si trabajas en una rama distinta de `main`, Vercel crea una dirección de vista previa para esa rama, útil para que tus colegas revisen una versión nueva de la base antes de aprobarla.

**Opción B, desde la terminal:**

```bash
npm i -g vercel
vercel          # primera vez: responde las preguntas y acepta los valores por defecto
vercel --prod   # publica en la dirección definitiva
```

**Restringir el acceso:** en el proyecto de Vercel, *Settings → Deployment Protection* permite exigir inicio de sesión de Vercel o una contraseña (esta última según el plan). La página ya pide a los buscadores no indexarla.

## Probar en tu computador

Necesitas Node 18 o superior.

```bash
npm run dev     # abre http://localhost:3000
npm test        # corre las pruebas del motor y de la base
```

Abrir `index.html` con doble clic no funciona: el navegador bloquea la lectura de `knowledge.json` fuera de un servidor.

## Flujo de validación con colegas

1. **Revisar hallazgos.** Cada colega activa **Modo revisión**, escribe su nombre y profesión, y en cada pregunta o diagnóstico usa **Comentar o proponer valores** (sensibilidad, especificidad o LR, con su fuente).
2. **Proponer lo que falta.** En **Evidencia y revisión → Proponer un hallazgo faltante** se agregan pruebas, preguntas o diagnósticos nuevos.
3. **Guardar casos.** En **Evaluar**, se responde un caso y se usa **Guardar como caso** indicando el diagnóstico confirmado y cómo se confirmó. Solo casos anonimizados o ficticios.
4. **Juntar el trabajo.** Todo queda en el navegador de cada persona. Cada colega usa **Exportar revisión (JSON)** y te envía el archivo; tú lo cargas con **Importar revisión**. Los elementos repetidos no se duplican.
5. **Medir.** **Validación de casos** muestra acierto top-1 y top-3, probabilidad media del diagnóstico confirmado y puntaje de Brier, en total y por diagnóstico. **Descargar casos (CSV)** exporta todo para analizarlo en Excel, R o SPSS.
6. **Corregir la base.** Aplica los cambios acordados en `public/data/knowledge.json`, sube la versión (`"version": "0.2.0"`) y anota el cambio abajo. Las métricas se recalculan sobre los mismos casos, así ves si el cambio mejoró o empeoró el modelo. Corre `npm test` antes de publicar.

## Cómo editar `knowledge.json`

- **Segmentos:** `"segments": [{ "id": "mano" }, { "id": "codo" }]`.
- **Diagnóstico:** `{ "id", "seg", "name", "prior" (0–1), "next" }`. El pre-test es para quien consulta por síntomas de *ese* segmento.
- **`seg` en hallazgos y señales de alarma:** `"mano"` o `"codo"` si la pregunta es propia de un segmento; sin `seg` = pregunta general (edad, sexo, diabetes, laboratorio…), que puede actualizar ambos. Un hallazgo con `seg` solo puede enlazar diagnósticos de su segmento (los tests lo verifican).
- **Hallazgo sí/no:** `{ "id", "st" (etapa), "who" (self | pro | lab | img), "grp" (opcional), "q", "help", "links": { "<id_dx>": {...} } }`.
  - Con sensibilidad y especificidad: `{ "se": 0.85, "sp": 0.95, "l": "A", "r": "AAEM" }`.
  - Con LR directos: `{ "p": 3.1, "n": 0.7, "l": "A", "r": "DM" }`.
- **Hallazgo de opción múltiple:** `"type": "choice"`, con `"opts": [{ "v", "t", "lr": { "<id_dx>": LR } }]`, y `"l"`, `"r"` a nivel del hallazgo.
- **Nivel de evidencia (`l`):** A = metaanálisis o revisión sistemática; B = estudio diagnóstico individual; C = estimación clínica.
- **`grp`:** agrupa hallazgos que miden lo mismo para que no se sumen dos veces (el más fuerte cuenta 100 %, el siguiente 50 %, luego 25 %).
- **`r`:** debe existir en `references`. Los tests fallan si no.

## Limitaciones conocidas

- Varios valores son nivel C (probabilidades pre-test, localización del dolor, factores de riesgo). Son la prioridad de revisión.
- El modelo supone independencia entre grupos de hallazgos; dentro de un grupo usa un descuento simple.
- Las probabilidades pre-test suponen una persona que consulta en atención primaria o kinesiología; en urgencia o en consulta de cirujano de mano serían otras.
- Cada segmento supone que la persona consulta por síntomas de ese segmento. Si en «Ambos» no hay respuestas propias de un segmento, la app lo atenúa y avisa que las cifras solo reflejan el pre-test y los datos generales.
- Codo-antebrazo es nuevo: la mayoría de sus valores son nivel C y son la prioridad de revisión.
- Los datos de revisión viven en el navegador. Para tener comentarios y casos compartidos en tiempo real, el siguiente paso es una base de datos (por ejemplo Supabase) con acceso por usuario.

## Registro de cambios de la base

- **0.1.0 (2026-11-04):** versión inicial, 11 diagnósticos, 6 etapas, 7 señales de alarma, 25 referencias.
- **0.2.0 (2026-11-17):** se agrega el segmento codo-antebrazo sin modificar los valores de mano-muñeca: 8 diagnósticos (epicondilalgia lateral y medial, neuropatía cubital, bursitis olecraniana, fractura de cabeza radial, rotura del bíceps distal, túnel radial/NIP, lesión del LCU), 37 hallazgos, 3 señales de alarma y 8 referencias. Los hallazgos generales (edad, sexo, diabetes, uso repetitivo, caída con la mano extendida) ganan enlaces a codo. Selector de segmento, un panel de resultados por segmento, sugerencias filtradas por segmento y validación top-1/top-3 dentro del segmento confirmado. 5 casos de ejemplo nuevos y 10 tests nuevos. Corregido: los elementos con `hidden` (por ejemplo, la barra de revisión) se mostraban igual.
