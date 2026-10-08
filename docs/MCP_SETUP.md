# Plantilla local de conexión MCP

Preparación genérica de 9.2. Requiere Node 24 y adaptador compilado. Cada persona genera la plantilla desde su propio clon para obtener rutas absolutas de su máquina.

```powershell
pnpm build
pnpm mcp:config --agent-name orlando-agente
pnpm mcp:config --agent-name amigo-agente --hub-url https://TU-HUB --project-id UUID-DEL-PROYECTO --output plantilla-mcp.json
```

En el segundo ejemplo, reemplazar URL y UUID antes de ejecutar. El destino debe ser nuevo y su carpeta debe existir; si el archivo ya existe, el comando falla y conserva su contenido. Sin `--output`, imprime JSON por stdout y no escribe ningún archivo. No modifica ni fusiona la configuración de un cliente instalado.

La plantilla contiene `mcpServers.agents-hub`, el ejecutable de Node y el script stdio con rutas absolutas, un nombre de agente y variables `AGENTS_HUB_*`. El token siempre es `TU_TOKEN_PERSONAL`, incluso si el entorno tiene una credencial real. Sin argumentos, URL y proyecto también son valores de ejemplo que deben reemplazarse. La URL admite HTTPS remoto o HTTP de loopback, sin credenciales/query/fragmento.

Revisar el formato/ubicación que exige el cliente seleccionado. Algunos clientes usan otras claves o mecanismos de configuración; esta plantilla no certifica compatibilidad de Claude, Cursor u otro producto. Registrar los dos clientes reales y su documentación oficial en [compatibilidad](compatibility/clients.md) antes de cerrar 7.1/9.2.

Una vez incorporada la plantilla al cliente, completar el token propio en configuración privada fuera del repositorio, comprobar URL/proyecto y ejecutar [doctor](DOCTOR.md). Usar nombres distintos para procesos simultáneos según [sesiones](SESSIONS.md). Reiniciar la conexión MCP del cliente, ejecutar `join_project`, publicar estado y revisar inbox; confirmar páginas sólo después de consumirlas.

La distribución instalable del adaptador (9.3) sigue pendiente: esta plantilla apunta al clon local y no publica paquetes ni incluye dependencias/credenciales del equipo.
