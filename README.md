# Evaluación de comprobantes con k6

Este repositorio prepara la evaluación del flujo de creación de comprobantes de Financiero de MinkaSoftware. La prueba recorre autenticación, contexto contable, formulario, búsqueda de cuentas, guardado, consulta del registro y descarga del PDF. El objetivo inicial es comprobar la integridad del recorrido y dejar configurados perfiles revisables para el trabajo del grupo.

## Requisitos

- Grafana k6 **v2.3.0**.
- PowerShell 7 o Windows PowerShell 5.1 para usar `bin/run.ps1`.
- Acceso al ambiente de prueba y una sesión con permisos para crear comprobantes.
- Para híbrida y cloud: token y stack de Grafana Cloud k6.

Clonación:

```powershell
git clone https://github.com/Eynar92/dip-cat-v-final.git
cd dip-cat-v-final
Copy-Item .env.example .env
```

En `.env`, reemplazar `FINANCIERO_USER`, `FINANCIERO_PASSWORD`, `FINANCIERO_BASE_URL`, `K6_CLOUD_TOKEN` y `K6_CLOUD_STACK_ID` con valores propios. `.env` no se versiona. La contraseña y los valores de Grafana no deben pegarse en comandos compartidos ni en documentación.

`FINANCIERO_USER` y `FINANCIERO_PASSWORD` son obligatorios en las tres modalidades. `K6_CLOUD_TOKEN` y `K6_CLOUD_STACK_ID` son obligatorios para híbrida y cloud. Se pueden definir en el entorno del proceso en vez de `.env`; el lanzador carga `.env` explícitamente cuando existe.

## Estructura

- `config/`: URL y contexto que se espera encontrar en la sesión.
- `profiles/`: concurrencia y duración orientativas, separadas del modo de ejecución.
- `thresholds/`: criterios de integridad smoke y criterios provisionales de performance.
- `data/`: plantillas externas compartidas de los cuatro tipos.
- `src/`: autenticación, correlación, envío multipart, verificaciones y métricas.
- `bin/`: selección de modo y perfil, validación previa y recolección del manifiesto.
- `docs/`: trazabilidad de las grabaciones y decisiones de implementación.
- `results/`: resultados y manifiestos locales, excluidos de Git.

Antes de una ejecución se revisan `config/environment.json`, los datos de `data/vouchers.json` y los perfiles elegidos. El contexto no se modifica para hacer posible una prueba.

## Flujos

El recorrido funcional usa una sesión de cookies independiente por VU. Comprueba el acceso, selecciona Contabilidad, lee el formulario y el contexto actual, solicita correlativo y fecha para el tipo elegido, abre las líneas, busca cada cuenta por su número y usa el ID devuelto por esa búsqueda. Después envía el formulario multipart, obtiene el ID interno de la respuesta, consulta `editar.php` y `edit_prueba.php`, verifica las líneas guardadas y pide el PDF. La respuesta de guardado contiene HTML y JavaScript; k6 extrae la referencia sin ejecutar ese JavaScript.

Las plantillas iniciales, todas balanceadas por 10 y sin facturas, auxiliares ni libretas, son:

- Ingreso (1) e Ingreso NR (4): CAJA M/N, Debe 10; OTROS INGRESOS, Haber 10.
- Egreso (2): GASTO EN IMPRENTA, Debe 10; CAJA M/N, Haber 10.
- Traspaso (3): CAJA M/N, Debe 10; GASTO EN IMPRENTA, Haber 10.

El ID de cuenta se busca en cada ejecución. No se utilizan como entrada los IDs ni correlativos de comprobantes anteriores. Ingreso NR mantiene su tipo propio y requiere validar su excepción de libreta bancaria por separado.

### Convenciones

Las glosas comienzan con `DIP_Cato-G6-`. El `runId` identifica una ejecución; el escenario se representa con un código corto del perfil (`SM`, `CV`, `BL`, `SU`, `SP` o `ST`); `V` identifica el VU global de k6 e `I` su iteración en ese escenario. Ejemplo completo: `DIP_Cato-G6-2611221030a1b2c3-SM-V1-I1`.

Se aplica la misma referencia a la cabecera y a cada línea del detalle. El smoke confirmó que el ambiente acepta glosas de 44 caracteres; como el formulario no publica un límite máximo, el proyecto limita cada glosa a esa longitud observada. El manifiesto local relaciona glosa, tipo, ejecución, VU, iteración, correlativo e ID interno. La glosa no se usa como etiqueta de métrica.

## Ejecución

El perfil smoke está limitado a un VU y cuatro iteraciones secuenciales, una por tipo. El resumen k6 aparece en la terminal; `results/` conserva el log de consola y un manifiesto NDJSON, y se excluye de Git.

```powershell
./bin/run.ps1 -Mode local -Profile smoke
```

Híbrida ejecuta los VUs localmente y envía resultados a Grafana Cloud. Cloud ejecuta generadores y resultados en Grafana Cloud:

```powershell
./bin/run.ps1 -Mode hybrid -Profile baseline
./bin/run.ps1 -Mode cloud -Profile baseline
```

Perfiles preparados: `smoke`, `concurrency-validation`, `baseline`, `sustained`, `spike` y `stress`. Los perfiles de carga y umbrales de performance son hipótesis provisionales del plan del grupo, no criterios definitivos aprobados. Aún deben revisarse con línea base, protocolo acordado y condiciones del ambiente compartido. La implementación inicial no ejecuta carga, spike ni estrés.

Para revisar argumentos y JSON sin ejecutar k6:

```powershell
./bin/run.ps1 -Mode cloud -Profile stress -CheckOnly
```

Las credenciales de acceso nunca forman parte del repositorio. El lanzador no imprime secretos. En cloud, k6 recibe las variables de acceso como variables de entorno de esa ejecución. Los modos híbrido y cloud se prepararon y se revisaron con `-CheckOnly`; no se ejecutaron ni se consumió cuota de Grafana Cloud.

## Verificación y estado

Los antecedentes describen cuatro comprobantes de exploración existentes (IDs 18346–18349) y uno de la grabación principal de Studio (ID 18350). Son datos ajenos a las ejecuciones nuevas de este repositorio; no se reutilizan ni se borran.

El smoke local de un VU y cuatro iteraciones produjo una alta por tipo. La primera ejecución tuvo una excepción del runtime al comenzar la consulta de persistencia, después de que el guardado devolviera los cuatro IDs; no se repitieron las altas. Tras corregir el acceso explícito a `edit_prueba.php`, las cuatro altas se revisaron con consultas autenticadas de solo lectura. Tipo, glosa de cabecera y líneas, fecha, cuentas, importes, totales y PDF pasaron para los cuatro registros. Los IDs y glosas exactos están en el manifiesto local bajo `results/`.

La estructura, el script y las configuraciones se inspeccionaron con k6 v2.3.0. Se revisaron los seis perfiles y los comandos para local, híbrido y cloud sin ejecutar carga. El smoke local fue la única ejecución contra el sistema. Las ejecuciones híbrida, cloud, línea base, carga sostenida, spike y estrés permanecen pendientes. No se ejecutó carga ni se consumió cuota de Grafana Cloud.

No se fijaron objetivos de latencia ni tasa de error para los perfiles de performance. Los thresholds provisionales conservan solo la integridad del negocio; el grupo debe acordar objetivos de rendimiento después de medir una línea base.

La comprobación de PDF valida estado HTTP, `Content-Type` y firma `%PDF`; no interpreta el contenido interno del archivo.
