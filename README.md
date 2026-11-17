# Predictor bayesiano de lesiones · Mano-muñeca + Codo-antebrazo

Prototipo estático (HTML + JS, sin build) que estima, para **ambos segmentos a la vez**, la probabilidad de cada lesión neuro-músculo-esquelética a partir de anamnesis, exámenes de sangre, evaluación física e imágenes.

- **Motor:** odds post-test = odds pre-test × Π LR (cada diagnóstico independiente; los % no suman 100).
- **Ajuste por calidad de evidencia:** el log-LR se multiplica por 1,0 / 0,8 / 0,6 (calidad A / B / C).
- **Qué evaluar ahora:** ganancia de información esperada (bits), filtrable por quién realiza la prueba.
- **Validación de casos:** viñetas en `knowledge.json → casos`.

## Editar la evidencia
Todo vive en `public/data/knowledge.json` (hallazgos, diagnósticos, LR, calidad, referencias, casos).
Puede editarse a mano o regenerarse con `python3 tools/build_kb.py public/data/knowledge.json`.
Los valores marcados `experto` (calidad C) son estimaciones provisorias y deben revisarse.

## Despliegue
Vercel sirve la carpeta `public/` (ver `vercel.json`). Cada push a `main` redespliega.

> Prototipo en validación. No entrega diagnósticos ni reemplaza el juicio clínico.
