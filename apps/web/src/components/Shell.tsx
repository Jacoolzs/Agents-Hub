import type React from "react";
import { useEffect, useState } from "react";
import { useHub } from "../context/HubContext.js";
import { Icon, type IconName } from "./Icon.js";
import { RecoveryPanel } from "./RecoveryPanel.js";

interface ShellProps {
  children: {
    messages: (active: boolean) => React.ReactNode;
    agents: (active: boolean) => React.ReactNode;
    locks: (active: boolean) => React.ReactNode;
    members: (active: boolean) => React.ReactNode;
  };
}

type Section = keyof ShellProps["children"];
const sections: {
  id: Section;
  label: string;
  icon: IconName;
  title: string;
  description: string;
}[] = [
  {
    id: "messages",
    label: "Mensajes",
    icon: "messages",
    title: "Conversación del equipo",
    description: "Acuerdos, preguntas y contexto compartido en un solo lugar.",
  },
  {
    id: "agents",
    label: "Equipo",
    icon: "agents",
    title: "Cada agente, su contexto",
    description: "Consulta los reportes, decisiones y bloqueos del proyecto.",
  },
  {
    id: "locks",
    label: "Archivos",
    icon: "locks",
    title: "Coordina antes de editar",
    description: "Reserva archivos y módulos para evitar trabajo que se pisa.",
  },
  {
    id: "members",
    label: "Miembros",
    icon: "members",
    title: "Un espacio compartido",
    description: "Gestiona las personas y los permisos de este proyecto.",
  },
];

function readSection(): Section {
  const section = window.location.hash.slice(1);
  return sections.some((item) => item.id === section) ? (section as Section) : "messages";
}

export function Shell({ children }: ShellProps) {
  const { auth, connectionStatus, disconnect } = useHub();
  const [activeTab, setActiveTab] = useState<Section>(readSection);
  const [visited, setVisited] = useState<Set<Section>>(() => new Set([readSection()]));
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === "#main-content") return;
      const section = readSection();
      setActiveTab(section);
      setVisited((current) => new Set([...current, section]));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  if (!auth) return null;
  const current = sections.find((section) => section.id === activeTab);
  if (!current) return null;
  const connectionLabel =
    connectionStatus === "connected"
      ? "Conectado (WS)"
      : connectionStatus === "connecting"
        ? "Conectando..."
        : connectionStatus === "reconnecting"
          ? "Reconectando (Inbox activo)..."
          : "Desconectado (Polling)";

  function navigate(section: Section) {
    setActiveTab(section);
    setVisited((existing) => new Set([...existing, section]));
    window.location.hash = section;
  }

  return (
    <div className="workspace">
      <a className="skip-link" href="#main-content">
        Saltar al contenido
      </a>
      <aside className="workspace-sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="hub" />
          </span>
          <span>
            Agents-Hub<small>Espacio de coordinación</small>
          </span>
        </div>
        <nav className="workspace-nav" aria-label="Secciones del proyecto">
          {sections.map((section) => (
            <button
              type="button"
              key={section.id}
              data-testid={`tab-${section.id}`}
              aria-current={activeTab === section.id ? "page" : undefined}
              aria-controls={`section-${section.id}`}
              onClick={() => navigate(section.id)}
            >
              <Icon name={section.icon} />
              <span>{section.label}</span>
              {activeTab === section.id && <span className="nav-marker" aria-hidden="true" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Icon name="hub" />
          <p>
            Tu equipo, conectado.<small>Mensajes, contexto y archivos compartidos.</small>
          </p>
        </div>
        <button type="button" className="disconnect-button" onClick={disconnect}>
          <Icon name="logout" />
          Desconectar
        </button>
      </aside>
      <div className="workspace-body">
        <header className="workspace-header">
          <div className="project-identity">
            <span className="project-symbol" aria-hidden="true">
              <Icon name="folder" />
            </span>
            <div>
              <strong>{auth.projectName || "Proyecto"}</strong>
              <details className="project-details">
                <summary>Identificador del proyecto</summary>
                <code>{auth.projectId}</code>
              </details>
            </div>
          </div>
          <div className="header-session">
            <div className="view-connection">
              <small>Conexión de esta vista</small>
              <output
                className={`connection-badge connection-${connectionStatus}`}
                aria-label={`Conexión de esta vista: ${connectionLabel}`}
              >
                <span aria-hidden="true" />
                {connectionLabel}
              </output>
            </div>
            <span className="session-name">
              <Icon name="agents" />
              <span>{auth.agentId}</span>
            </span>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="workspace-main">
          <div className="page-heading">
            <h1>{current.title}</h1>
            <p>{current.description}</p>
          </div>
          <RecoveryPanel />
          {sections.map(
            (section) =>
              visited.has(section.id) && (
                <section
                  key={section.id}
                  id={`section-${section.id}`}
                  hidden={activeTab !== section.id}
                  aria-label={section.label}
                >
                  {children[section.id](activeTab === section.id)}
                </section>
              ),
          )}
        </main>
      </div>
    </div>
  );
}
