import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Board, Card, CardComment, ColumnId, Project } from "../../src/types";
import { hasPermission } from "acme-identity/permissions";
import type { AuthMode, Principal } from "acme-identity/types";
import { api, formatTime } from "./api";

type Dialog = "project" | "edit-project" | "card" | null;
type WorkspaceView = "board" | "connections";

type SteeringIntegrationStatus = {
  configured: boolean;
  url: string;
  source: "stored" | "environment" | "unconfigured";
  status: "online" | "offline" | "unconfigured";
  detail: string;
  checkedAt: string;
  credentialConfigured: boolean;
  credentialWillBeSent: boolean;
  startupConfigured: boolean;
};

type AuthSession = {
  schemaVersion: "acme.session.v1";
  authMode: AuthMode;
  accountUrl?: string;
  principal: Principal;
};

type ProjectsAuth = {
  session: AuthSession;
  canWrite: boolean;
  signOut: () => void;
  signingOut: boolean;
};

const ProjectsAuthContext = createContext<ProjectsAuth | null>(null);

function useOutsideDismissDetails() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      const menu = ref.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, []);
  return ref;
}

function useProjectsAuth(): ProjectsAuth {
  const value = useContext(ProjectsAuthContext);
  if (!value) throw new Error("Projects auth context is unavailable");
  return value;
}

export function App() {
  const queryClient = useQueryClient();
  const auth = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => api<AuthSession>("/api/auth/session"),
    retry: false,
  });
  const signOut = useMutation({
    mutationFn: () => api("/api/auth/session", { method: "DELETE" }),
    onSuccess: async () => {
      queryClient.clear();
      await auth.refetch();
    },
  });

  if (auth.isLoading) return <AuthLoading />;
  if (!auth.data?.principal) {
    return (
      <Login
        error={auth.error?.message === "Authentication required" ? undefined : auth.error?.message}
        onSignedIn={async () => {
          await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
        }}
      />
    );
  }

  return (
    <ProjectsAuthContext.Provider value={{
      session: auth.data,
      canWrite: hasPermission(auth.data.principal, "projects.write"),
      signOut: () => signOut.mutate(),
      signingOut: signOut.isPending,
    }}>
      <AuthenticatedApp />
    </ProjectsAuthContext.Provider>
  );
}

function AuthenticatedApp() {
  const queryClient = useQueryClient();
  const { canWrite } = useProjectsAuth();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/api/projects"),
  });
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem("acme-project-id"));
    return Number.isInteger(saved) && saved > 0 ? saved : null;
  });
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [view, setView] = useState<WorkspaceView>("board");
  const [newCardColumn, setNewCardColumn] = useState<ColumnId>("ideas");
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!projects.data?.length) {
      setSelectedProjectId(null);
      return;
    }
    if (!projects.data.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects.data[0].id);
    }
  }, [projects.data, selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId) localStorage.setItem("acme-project-id", String(selectedProjectId));
  }, [selectedProjectId]);

  const board = useQuery({
    queryKey: ["board", selectedProjectId],
    queryFn: () => api<Board>(`/api/projects/${selectedProjectId}/board`),
    enabled: selectedProjectId !== null,
  });

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2_800);
  };

  const deleteProject = useMutation({
    mutationFn: (id: number) => api<void>(`/api/projects/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setSelectedProjectId(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      showToast("Project deleted");
    },
    onError: (error) => showToast(error.message),
  });

  return (
    <div className="app-shell">
      <Header onNewProject={canWrite ? () => setDialog("project") : undefined} />
      <div className="workspace">
        <ProjectSidebar
          projects={projects.data ?? []}
          selectedId={selectedProjectId}
          view={view}
          onSelect={(id) => {
            setSelectedProjectId(id);
            setView("board");
          }}
          onConnections={() => setView("connections")}
          onNew={canWrite ? () => setDialog("project") : undefined}
        />
        <main className="main-content">
          {view === "connections" ? (
            <ConnectionsView canWrite={canWrite} onToast={showToast} />
          ) : projects.isLoading ? (
            <CenteredMessage title="Opening your workspace…" />
          ) : !projects.data?.length ? (
            <Welcome onCreate={canWrite ? () => setDialog("project") : undefined} />
          ) : board.data ? (
            <>
              <BoardHeader
                project={board.data.project}
                cardCount={board.data.columns.reduce((sum, column) => sum + column.cards.length, 0)}
                onEdit={canWrite ? () => setDialog("edit-project") : undefined}
                onDelete={canWrite ? () => {
                  if (
                    confirm(
                      `Delete “${board.data.project.name}” and all of its cards?\n\nLinked issues are left alone; only this project board is removed.`,
                    )
                  ) {
                    deleteProject.mutate(board.data.project.id);
                  }
                } : undefined}
              />
              <ProjectBoard
                board={board.data}
                onCard={setSelectedCardId}
                onNewCard={canWrite ? (columnId) => {
                  setNewCardColumn(columnId);
                  setDialog("card");
                } : undefined}
                onToast={showToast}
              />
            </>
          ) : board.isError ? (
            <CenteredMessage title="Could not open this project" body={board.error.message} />
          ) : (
            <CenteredMessage title="Loading board…" />
          )}
        </main>
      </div>

      {canWrite && dialog === "project" && (
        <NewProjectDialog
          onClose={() => setDialog(null)}
          onCreated={(project) => {
            setDialog(null);
            setSelectedProjectId(project.id);
            showToast("Project created");
          }}
        />
      )}
      {canWrite && dialog === "edit-project" && board.data && (
        <ProjectSettingsDialog
          project={board.data.project}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            showToast("Project settings saved");
          }}
        />
      )}
      {canWrite && dialog === "card" && selectedProjectId && (
        <NewCardDialog
          projectId={selectedProjectId}
          columnId={newCardColumn}
          onClose={() => setDialog(null)}
          onCreated={(card) => {
            setDialog(null);
            setSelectedCardId(card.id);
            showToast("Card added");
          }}
        />
      )}
      {selectedCardId && board.data && (
        <CardDetail
          cardId={selectedCardId}
          project={board.data.project}
          onClose={() => setSelectedCardId(null)}
          onDeleted={() => {
            setSelectedCardId(null);
            showToast("Card deleted");
          }}
          onToast={showToast}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Header({ onNewProject }: { onNewProject?: () => void }) {
  const { session, signOut, signingOut } = useProjectsAuth();
  const accountMenuRef = useOutsideDismissDetails();
  return (
    <header className="app-header">
      <div className="brand">
        <BrandMark />
        <div className="brand-copy">
          <strong>Acme Projects</strong>
          <span>Shape ideas into work worth doing</span>
        </div>
      </div>
      <div className="header-actions">
        {onNewProject && <button className="button primary" onClick={onNewProject}>
        <PlusIcon /> New project
        </button>}
        <details className="account-menu" ref={accountMenuRef}>
          <summary className="account-trigger" aria-label={`Account: ${session.principal.displayName}`}>
            <span className="account-avatar" aria-hidden="true">{session.principal.displayName.charAt(0).toUpperCase()}</span>
            <span className="account-trigger-name">{session.principal.displayName}</span>
          </summary>
          <div className="account-popover">
            <div className="account-heading">
              <strong>{session.principal.displayName}</strong>
              <span>@{session.principal.username}</span>
            </div>
            <div className="account-context">
              <span className={`account-status ${session.authMode === "off" ? "development" : "connected"}`} />
              <div>
                <strong>{session.authMode === "off" ? "Authentication off" : "Acme Identity"}</strong>
                <span>{session.authMode === "off" ? "Development admin access" : session.principal.roles.join(", ") || session.principal.kind}</span>
              </div>
            </div>
            {session.accountUrl && (
              <a className="account-action" href={session.accountUrl} target="_blank" rel="noreferrer">
                My identity account <span aria-hidden="true">↗</span>
              </a>
            )}
            {session.authMode === "local" && (
              <button className="account-action" type="button" disabled={signingOut} onClick={signOut}>Sign out</button>
            )}
          </div>
        </details>
      </div>
    </header>
  );
}

function ProjectSidebar({
  projects,
  selectedId,
  view,
  onSelect,
  onConnections,
  onNew,
}: {
  projects: Project[];
  selectedId: number | null;
  view: WorkspaceView;
  onSelect: (id: number) => void;
  onConnections: () => void;
  onNew?: () => void;
}) {
  return (
    <aside className="project-sidebar">
      <div className="sidebar-heading">
        <span>Projects</span>
        {onNew && <button className="icon-button" onClick={onNew} aria-label="New project"><PlusIcon /></button>}
      </div>
      <nav className="project-list">
        {projects.map((project) => (
          <button
            key={project.id}
            className={`project-link ${view === "board" && project.id === selectedId ? "active" : ""}`}
            onClick={() => onSelect(project.id)}
          >
            <span className="project-initial">{project.name.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{project.name}</strong>
              <small>{project.description || "Project board"}</small>
            </span>
          </button>
        ))}
      </nav>
      <button
        type="button"
        className={`project-link sidebar-connection ${view === "connections" ? "active" : ""}`}
        onClick={onConnections}
      >
        <span className="project-initial">S</span>
        <span>
          <strong>Connections</strong>
          <small>Steering integration</small>
        </span>
      </button>
      <div className="sidebar-note">
        <SparkIcon />
        <p><strong>Explore first.</strong> Ready cards can be submitted to an issues system when a human chooses.</p>
      </div>
    </aside>
  );
}

function BoardHeader({
  project,
  cardCount,
  onEdit,
  onDelete,
}: {
  project: Project;
  cardCount: number;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <section className="board-header">
      <div>
        <div className="eyebrow">Project board</div>
        <h1>{project.name}</h1>
        <p>{project.description || "A shared space for ideas, decisions, and implementation intent."}</p>
        <div className={`repository-scope ${project.issuesUrl && project.issuesProjectRef ? "" : "unset"}`}>
          <LinkIcon />
          {project.issuesUrl && project.issuesProjectRef
            ? `${project.issuesUrl} · ${project.issuesProjectRef}`
            : "Connect issues system"}
        </div>
        {project.repositoryPath ? (
          <div className="repository-scope">
            <RepoIcon />
            {project.repositoryPath}
          </div>
        ) : null}
      </div>
      <div className="board-meta">
        <span>{cardCount} {cardCount === 1 ? "card" : "cards"}</span>
        {onEdit && <button className="text-button" onClick={onEdit}>Project settings</button>}
        {onDelete && <button className="text-button danger" onClick={onDelete}>Delete project</button>}
      </div>
    </section>
  );
}

function ProjectBoard({
  board,
  onCard,
  onNewCard,
  onToast,
}: {
  board: Board;
  onCard: (id: number) => void;
  onNewCard?: (columnId: ColumnId) => void;
  onToast: (message: string) => void;
}) {
  const { canWrite } = useProjectsAuth();
  const queryClient = useQueryClient();
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const move = useMutation({
    mutationFn: ({ id, columnId, index }: { id: number; columnId: ColumnId; index: number }) =>
      api<Card>(`/api/cards/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ columnId, index }),
      }),
    onSuccess: async (card) => {
      await queryClient.invalidateQueries({ queryKey: ["board", board.project.id] });
    },
    onError: (error) => onToast(error.message),
  });

  const drop = (event: React.DragEvent, columnId: ColumnId, index: number) => {
    event.preventDefault();
    if (!canWrite) return;
    const id = Number(event.dataTransfer.getData("text/card-id"));
    setDraggingId(null);
    if (!Number.isInteger(id) || id <= 0) return;
    const card = board.columns.flatMap((column) => column.cards).find((item) => item.id === id);
    if (!card) return;
    if (columnId !== card.columnId && card.activeImplementation) {
      onToast("Use Return to exploration while this card has a linked issue");
      return;
    }
    if (
      columnId !== card.columnId &&
      (columnId === "in_progress" || columnId === "in_review" || columnId === "done")
    ) {
      onToast("Implementation columns are controlled by external lifecycle events");
      return;
    }
    move.mutate({ id, columnId, index });
  };

  return (
    <div className="board-scroll">
      <div className="board" aria-label={`${board.project.name} board`}>
        {board.columns.map((column) => (
          <section
            className={`board-column column-${column.id}`}
            key={column.id}
            onDragOver={(event) => { if (canWrite) event.preventDefault(); }}
            onDrop={(event) => drop(event, column.id, column.cards.length)}
          >
            <header className="column-header">
              <div>
                <span className="column-dot" />
                <h2>{column.name}</h2>
                <span className="card-count">{column.cards.length}</span>
              </div>
              <p>{column.description}</p>
            </header>
            <div className="card-list">
              {column.cards.map((card, index) => (
                <div
                  key={card.id}
                  onDragOver={(event) => { if (canWrite) event.preventDefault(); }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    drop(event, column.id, index);
                  }}
                >
                  <BoardCard
                    card={card}
                    draggable={canWrite}
                    dragging={draggingId === card.id}
                    onOpen={() => onCard(card.id)}
                    onDragStart={(event) => {
                      setDraggingId(card.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/card-id", String(card.id));
                    }}
                    onDragEnd={() => setDraggingId(null)}
                  />
                </div>
              ))}
              {!column.cards.length && (
                <div className="empty-column">
                  {column.id === "in_progress" || column.id === "in_review" || column.id === "done"
                    ? "Updated by implementation events"
                    : "Drop an idea here"}
                </div>
              )}
            </div>
            {onNewCard && column.id !== "in_progress" && column.id !== "in_review" && column.id !== "done" && (
              <button className="add-card" onClick={() => onNewCard(column.id)}>
                <PlusIcon /> Add card
              </button>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function BoardCard({
  card,
  dragging,
  draggable,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  card: Card;
  dragging: boolean;
  draggable: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <article
      className={`board-card ${dragging ? "dragging" : ""}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen();
      }}
    >
      <h3>{card.title}</h3>
      {card.description && <p>{card.description}</p>}
      <footer>
        <span className="card-id">ACM-{card.id}</span>
        <span className="card-signals">
          {card.activeImplementation && (
            <span className="issue-signal" title={`Linked issue #${card.activeImplementation.issueId}`}>
              <LinkIcon /> #{card.activeImplementation.issueId}
            </span>
          )}
          {card.commentCount > 0 && <span><CommentIcon /> {card.commentCount}</span>}
        </span>
      </footer>
    </article>
  );
}

function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      repositoryPath: string;
      issuesUrl: string;
      issuesProjectRef: string;
    }) =>
      api<Project>("/api/projects", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onCreated(project);
    },
  });
  return (
    <Dialog title="Create a project" subtitle="Give an area of exploration its own board." onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          mutation.mutate({
            name: String(data.get("name")),
            description: String(data.get("description")),
            repositoryPath: String(data.get("repositoryPath")),
            issuesUrl: String(data.get("issuesUrl")),
            issuesProjectRef: String(data.get("issuesProjectRef")),
          });
        }}
      >
        <Field label="Project name">
          <input name="name" autoFocus required placeholder="e.g. Customer workspace" />
        </Field>
        <Field label="Short description" hint="What space does this project create?">
          <textarea name="description" rows={3} placeholder="Explore a simpler way for customers to…" />
        </Field>
        <Field
          label="Issues system URL"
          hint="Base URL of the issues tracker that receives Ready-card handoffs."
        >
          <input
            name="issuesUrl"
            type="url"
            defaultValue="http://127.0.0.1:8320"
            placeholder="http://127.0.0.1:8320"
          />
        </Field>
        <Field
          label="Issues system project"
          hint="Slug or id of the issues project that should receive submitted cards (for example acme-todo)."
        >
          <input
            name="issuesProjectRef"
            defaultValue="default"
            placeholder="default"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Repository path"
          hint="Optional later. Not used for today's Issues → Helix handoff."
        >
          <input name="repositoryPath" placeholder="/path/to/repository" />
        </Field>
        <FormError error={mutation.error} />
        <DialogActions onClose={onClose} submit="Create project" busy={mutation.isPending} />
      </form>
    </Dialog>
  );
}

function ProjectSettingsDialog({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      repositoryPath: string;
      issuesUrl: string;
      issuesProjectRef: string;
    }) =>
      api<Project>(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["board", project.id] }),
      ]);
      onSaved();
    },
  });
  return (
    <Dialog
      title="Project settings"
      subtitle="Define the shared scope inherited by every card."
      onClose={onClose}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          mutation.mutate({
            name: String(data.get("name")),
            description: String(data.get("description")),
            repositoryPath: String(data.get("repositoryPath")),
            issuesUrl: String(data.get("issuesUrl")),
            issuesProjectRef: String(data.get("issuesProjectRef")),
          });
        }}
      >
        <Field label="Project name">
          <input name="name" defaultValue={project.name} autoFocus required />
        </Field>
        <Field
          label="Issues system URL"
          hint="Submitting a Ready card creates a non-triggering issue here. Helix runs in the Helix serve workspace."
        >
          <input
            name="issuesUrl"
            type="url"
            defaultValue={project.issuesUrl}
            placeholder="http://127.0.0.1:8320"
          />
        </Field>
        <Field
          label="Issues system project"
          hint="Slug or id of the issues project that receives submitted cards."
        >
          <input
            name="issuesProjectRef"
            defaultValue={project.issuesProjectRef}
            placeholder="default"
            autoComplete="off"
          />
        </Field>
        <Field label="Short description">
          <textarea name="description" rows={3} defaultValue={project.description} />
        </Field>
        <Field
          label="Repository path"
          hint="Optional later for multi-repo routing. Leave blank for the current single-Helix test flow."
        >
          <input
            name="repositoryPath"
            defaultValue={project.repositoryPath}
            placeholder="/path/to/repository"
          />
        </Field>
        <FormError error={mutation.error} />
        <DialogActions onClose={onClose} submit="Save settings" busy={mutation.isPending} />
      </form>
    </Dialog>
  );
}

function NewCardDialog({
  projectId,
  columnId,
  onClose,
  onCreated,
}: {
  projectId: number;
  columnId: ColumnId;
  onClose: () => void;
  onCreated: (card: Card) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: { title: string; description: string; columnId: ColumnId }) =>
      api<Card>(`/api/projects/${projectId}/cards`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: async (card) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["board", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      onCreated(card);
    },
  });
  return (
    <Dialog title="Add a card" subtitle="Capture enough context to begin the conversation." onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          mutation.mutate({
            title: String(data.get("title")),
            description: String(data.get("description")),
            columnId,
          });
        }}
      >
        <Field label="Title">
          <input name="title" autoFocus required placeholder="What could be better?" />
        </Field>
        <Field label="Starting thought" hint="A rough idea is enough. It can evolve on the card.">
          <textarea name="description" rows={5} placeholder="Describe the opportunity, user need, or question…" />
        </Field>
        <FormError error={mutation.error} />
        <DialogActions onClose={onClose} submit="Add card" busy={mutation.isPending} />
      </form>
    </Dialog>
  );
}

function CardDetail({
  cardId,
  project,
  onClose,
  onDeleted,
  onToast,
}: {
  cardId: number;
  project: Project;
  onClose: () => void;
  onDeleted: () => void;
  onToast: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { canWrite } = useProjectsAuth();
  const card = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => api<Card>(`/api/cards/${cardId}`),
  });
  const comments = useQuery({
    queryKey: ["comments", cardId],
    queryFn: () => api<CardComment[]>(`/api/cards/${cardId}/comments`),
  });
  const [draft, setDraft] = useState<Partial<Card>>({});

  useEffect(() => {
    if (card.data) setDraft(card.data);
  }, [card.data]);

  const save = useMutation({
    mutationFn: () => api<Card>(`/api/cards/${cardId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: draft.title,
        description: draft.description,
        decisions: draft.decisions,
        openQuestions: draft.openQuestions,
        acceptanceNotes: draft.acceptanceNotes,
      }),
    }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["card", cardId], updated);
      await queryClient.invalidateQueries({ queryKey: ["board", updated.projectId] });
      onToast("Card saved");
    },
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/api/cards/${cardId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["board"] });
      onDeleted();
    },
  });
  const submitIssue = useMutation({
    mutationFn: async () => {
      await api<Card>(`/api/cards/${cardId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: draft.title,
          description: draft.description,
          decisions: draft.decisions,
          openQuestions: draft.openQuestions,
          acceptanceNotes: draft.acceptanceNotes,
        }),
      });
      return api<{ card: Card }>(`/api/cards/${cardId}/submit-issue`, { method: "POST" });
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(["card", cardId], result.card);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["board", result.card.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      onToast(`Created issues system issue #${result.card.activeImplementation?.issueId}`);
    },
  });
  const returnToExploration = useMutation({
    mutationFn: () => api<{ card: Card }>(`/api/cards/${cardId}/return-to-exploration`, {
      method: "POST",
    }),
    onSuccess: async (result) => {
      queryClient.setQueryData(["card", cardId], result.card);
      await queryClient.invalidateQueries({ queryKey: ["board", result.card.projectId] });
      onToast("Issue withdrawn and card returned to Exploring");
    },
  });

  if (!card.data || !draft.title) {
    return (
      <Dialog title="Opening card…" onClose={onClose} wide>
        <div className="loading-block">Loading conversation</div>
      </Dialog>
    );
  }

  const update = (key: keyof Card, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <Dialog title={`ACM-${cardId}`} onClose={onClose} wide>
      <div className="card-detail">
        <div className="card-edit">
          <input
            className="title-input"
            value={draft.title ?? ""}
            readOnly={!canWrite}
            onChange={(event) => update("title", event.target.value)}
            aria-label="Card title"
          />
          <div className={`stage-banner stage-${card.data.columnId}`}>
            <span className="column-dot" />
            {stageLabel(card.data.columnId)}
            {card.data.columnId === "ready" && <small>Eligible for issue submission</small>}
          </div>
          {card.data.columnId === "ready" && (
            <ImplementationPanel
              card={card.data}
              project={project}
              submitting={submitIssue.isPending}
              withdrawing={returnToExploration.isPending}
              error={submitIssue.error ?? returnToExploration.error}
              onSubmit={() => {
                if (confirm("Create a non-triggering implementation issue in the connected issues system?")) {
                  submitIssue.mutate();
                }
              }}
              onReturn={() => {
                if (confirm("Close the linked issue and return this card to Exploring?")) {
                  returnToExploration.mutate();
                }
              }}
              canWrite={canWrite}
            />
          )}
          <Field label="The idea" hint="Keep the current shared understanding here.">
            <textarea
              rows={6}
              value={draft.description ?? ""}
              readOnly={!canWrite}
              onChange={(event) => update("description", event.target.value)}
              placeholder="What are we exploring, and why might it matter?"
            />
          </Field>
          <div className="detail-grid">
            <Field label="Decisions">
              <textarea
                rows={5}
                value={draft.decisions ?? ""}
                readOnly={!canWrite}
                onChange={(event) => update("decisions", event.target.value)}
                placeholder="What have we agreed?"
              />
            </Field>
            <Field label="Open questions">
              <textarea
                rows={5}
                value={draft.openQuestions ?? ""}
                readOnly={!canWrite}
                onChange={(event) => update("openQuestions", event.target.value)}
                placeholder="What still needs an answer?"
              />
            </Field>
          </div>
          <Field label="Acceptance notes" hint="What would make the implemented result feel complete?">
            <textarea
              rows={4}
              value={draft.acceptanceNotes ?? ""}
              readOnly={!canWrite}
              onChange={(event) => update("acceptanceNotes", event.target.value)}
              placeholder="Describe a successful outcome…"
            />
          </Field>
          <FormError error={save.error} />
          {canWrite && <div className="detail-actions">
            <button
              className="text-button danger"
              onClick={() => {
                if (confirm("Delete this card and its discussion?")) remove.mutate();
              }}
            >
              Delete card
            </button>
            <button
              className="button primary"
              disabled={save.isPending || !draft.title?.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>}
        </div>
        <Discussion
          cardId={cardId}
          comments={comments.data ?? []}
          loading={comments.isLoading}
          onAdded={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["comments", cardId] }),
              queryClient.invalidateQueries({ queryKey: ["card", cardId] }),
              queryClient.invalidateQueries({ queryKey: ["board", card.data.projectId] }),
            ]);
          }}
        />
      </div>
    </Dialog>
  );
}

function ImplementationPanel({
  card,
  project,
  submitting,
  withdrawing,
  error,
  onSubmit,
  onReturn,
  canWrite,
}: {
  card: Card;
  project: Project;
  submitting: boolean;
  withdrawing: boolean;
  error: Error | null;
  onSubmit: () => void;
  onReturn: () => void;
  canWrite: boolean;
}) {
  const attempt = card.activeImplementation;
  if (attempt) {
    return (
      <section className="implementation-panel linked">
        <div className="implementation-icon"><LinkIcon /></div>
        <div className="implementation-copy">
          <span className="eyebrow">Implementation issue</span>
          <strong>Awaiting manual trigger</strong>
          <p>
            Issue <a href={attempt.issueUrl} target="_blank" rel="noreferrer">#{attempt.issueId}</a>
            {" "}was created without the <code>{attempt.triggerLabel}</code> label. Add it in the issues system when ready.
          </p>
          <FormError error={error} />
          {canWrite && <button className="button ghost small" disabled={withdrawing} onClick={onReturn}>
            {withdrawing ? "Withdrawing…" : "Return to exploration"}
          </button>}
        </div>
      </section>
    );
  }

  const missing = [
    !project.issuesUrl && "issues system URL",
    !project.issuesProjectRef.trim() && "issues system project",
  ].filter(Boolean);
  return (
    <section className="implementation-panel">
      <div className="implementation-icon"><SendIcon /></div>
      <div className="implementation-copy">
        <span className="eyebrow">Ready for implementation</span>
        <strong>Submit as an issue</strong>
        <p>
          This creates an issues-system issue labeled <code>acme-projects</code>.
          It will not trigger Helix until a human adds that tracker&apos;s configured trigger label.
          The run then uses the Helix instance the issues system is pointed at (its serve workspace).
        </p>
        {missing.length > 0 && (
          <p className="configuration-warning">Set the {missing.join(" and ")} in Project settings first.</p>
        )}
        <FormError error={error} />
        {canWrite && <button
          className="button primary small"
          disabled={submitting || missing.length > 0 || !card.title.trim()}
          onClick={onSubmit}
        >
          <SendIcon /> {submitting ? "Submitting…" : "Submit as issue"}
        </button>}
      </div>
    </section>
  );
}

function Discussion({
  cardId,
  comments,
  loading,
  onAdded,
}: {
  cardId: number;
  comments: CardComment[];
  loading: boolean;
  onAdded: () => Promise<void>;
}) {
  const { canWrite, session } = useProjectsAuth();
  const [body, setBody] = useState("");
  const mutation = useMutation({
    mutationFn: () => api<CardComment>(`/api/cards/${cardId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, author: session.principal.displayName }),
    }),
    onSuccess: async () => {
      setBody("");
      await onAdded();
    },
  });
  return (
    <aside className="discussion">
      <div className="discussion-heading">
        <div>
          <span className="eyebrow">Conversation</span>
          <h2>Discussion</h2>
        </div>
        <span>{comments.length}</span>
      </div>
      <div className="comment-list">
        {loading ? (
          <p className="muted">Loading discussion…</p>
        ) : comments.length ? (
          comments.map((comment) => (
            <article className="comment" key={comment.id}>
              <header>
                <span className="avatar">{comment.author.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{comment.author}</strong>
                  <time>{formatTime(comment.createdAt)}</time>
                </div>
              </header>
              <p>{comment.body}</p>
            </article>
          ))
        ) : (
          <div className="empty-discussion">
            <CommentIcon />
            <p>No discussion yet.</p>
            <span>Use comments for questions, alternatives, and context that should not be lost.</span>
          </div>
        )}
      </div>
      {canWrite && <form
        className="comment-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim()) mutation.mutate();
        }}
      >
        <textarea
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add to the conversation…"
        />
        <button className="button small" disabled={!body.trim() || mutation.isPending}>
          Comment
        </button>
      </form>}
    </aside>
  );
}

function Welcome({ onCreate }: { onCreate?: () => void }) {
  return (
    <section className="welcome">
      <div className="welcome-art" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="eyebrow">A place to think together</div>
      <h1>Start with an idea,<br />not a ticket.</h1>
      <p>{onCreate
        ? "Create a project board to explore possibilities, record decisions, and shape work before implementation begins."
        : "No project boards are available. Ask someone with Projects write access to create one."}</p>
      {onCreate && <button className="button primary large" onClick={onCreate}><PlusIcon /> Create your first project</button>}
    </section>
  );
}

function CenteredMessage({ title, body }: { title: string; body?: string }) {
  return <div className="centered-message"><strong>{title}</strong>{body && <p>{body}</p>}</div>;
}

function AuthLoading() {
  return (
    <div className="auth-page">
      <div className="auth-card"><p>Resolving Acme identity…</p></div>
    </div>
  );
}

function Login({ error, onSignedIn }: { error?: string; onSignedIn: () => Promise<void> }) {
  const [message, setMessage] = useState(error ?? "");
  const login = useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      api("/api/auth/session", { method: "POST", body: JSON.stringify(credentials) }),
    onSuccess: onSignedIn,
    onError: (loginError: Error) => setMessage(loginError.message),
  });
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          login.mutate({
            username: String(form.get("username") ?? ""),
            password: String(form.get("password") ?? ""),
          });
        }}
      >
        <BrandMark />
        <div><p className="auth-eyebrow">Acme Identity</p><h1>Sign in to Acme Projects</h1></div>
        <Field label="Username">
          <input name="username" autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        {message && <p className="form-error" role="alert">{message}</p>}
        <button className="button primary" type="submit" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Dialog({
  title,
  subtitle,
  wide,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <header className="dialog-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button close-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ConnectionsView({ canWrite, onToast }: { canWrite: boolean; onToast: (message: string) => void }) {
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: ["steering-integration"],
    queryFn: () => api<SteeringIntegrationStatus>("/api/integrations/steering"),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (connection.data) setUrl(connection.data.url);
  }, [connection.data?.url]);

  const save = useMutation({
    mutationFn: (nextUrl: string | null) => api<SteeringIntegrationStatus>("/api/integrations/steering", {
      method: "PATCH",
      body: JSON.stringify({ url: nextUrl }),
    }),
    onSuccess: async (result) => {
      queryClient.setQueryData(["steering-integration"], result);
      setUrl(result.url);
      onToast(result.configured ? "Steering connection saved" : "Steering notifications disabled");
    },
    onError: (error: Error) => onToast(error.message),
  });

  const test = useMutation({
    mutationFn: () => api<SteeringIntegrationStatus>("/api/integrations/steering/test", { method: "POST" }),
    onSuccess: (result) => {
      queryClient.setQueryData(["steering-integration"], result);
      onToast(result.status === "online" ? "Steering is online" : result.detail);
    },
    onError: (error: Error) => onToast(error.message),
  });

  const current = connection.data;
  const changed = current !== undefined && url.trim().replace(/\/$/, "") !== current.url.replace(/\/$/, "");

  return (
    <div className="connections-view">
      <div className="board-header connections-header">
        <div>
          <div className="eyebrow">Local integrations</div>
          <h1>Connections</h1>
          <p>Optional Acme Steering integration for Ready-card submission decisions.</p>
        </div>
      </div>
      <section className="connection-card">
        <div className="connection-heading">
          <div>
            <p className="eyebrow">Workflow steering</p>
            <h2>
              Acme Steering
              <span className={`connection-status ${current?.status ?? "pending"}`}>
                {connection.isLoading ? "checking" : current?.status ?? "unknown"}
              </span>
            </h2>
            <p className="connection-note">
              Projects publishes Ready-card lifecycle events and receives narrow Issues-handoff decisions through this connection.
            </p>
          </div>
        </div>
        {connection.isError ? (
          <p className="form-error">{connection.error.message}</p>
        ) : (
          <div className="connection-stack">
            <Field label="Steering URL">
              <input
                value={url}
                readOnly={!canWrite}
                placeholder="http://127.0.0.1:8323"
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <p className="connection-detail">{current?.detail ?? "Checking the connection…"}</p>
            {current?.source === "environment" && (
              <p className="hint">Provided by startup configuration. Saving here creates a Projects-local override.</p>
            )}
            {current?.credentialConfigured && !current.credentialWillBeSent && current.configured && (
              <p className="connection-warning">A service credential exists, but it will not be sent until this origin is trusted by the server configuration.</p>
            )}
            <p className="hint">Credentials remain server-side and cannot be viewed or changed here.</p>
            <div className="connection-actions">
              {canWrite && current?.source === "stored" && current.startupConfigured && (
                <button className="button ghost" type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>Use startup setting</button>
              )}
              {canWrite && current?.configured && (
                <button className="button ghost" type="button" disabled={save.isPending} onClick={() => save.mutate("")}>Disable</button>
              )}
              <button className="button" type="button" disabled={!current?.configured || test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? "Testing…" : "Test connection"}
              </button>
              {canWrite && (
                <button className="button primary" type="button" disabled={!changed || save.isPending} onClick={() => save.mutate(url)}>
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function DialogActions({
  onClose,
  submit,
  busy,
}: {
  onClose: () => void;
  submit: string;
  busy: boolean;
}) {
  return (
    <div className="dialog-actions">
      <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={busy}>{busy ? "Working…" : submit}</button>
    </div>
  );
}

function FormError({ error }: { error: Error | null }) {
  return error ? <p className="form-error">{error.message}</p> : null;
}

function stageLabel(id: ColumnId): string {
  return id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 36 36" fill="none">
        <rect width="36" height="36" rx="10" fill="#1E6F68" />
        <path d="M9 12.5h18M9 18h13M9 23.5h16" stroke="#FFFDF7" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="27" cy="12.5" r="3.5" fill="#F4B860" />
      </svg>
    </span>
  );
}

function PlusIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>;
}

function SparkIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2c.5 4.4 3 7 7 8-4 1-6.5 3.6-7 8-.5-4.4-3-7-7-8 4-1 6.5-3.6 7-8Z" /></svg>;
}

function CommentIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5a2 2 0 0 1-2 2H7l-3.5 2v-2a2 2 0 0 1-1-1.73V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5Z" /></svg>;
}

function RepoIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h7a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2v-9Zm2 0v9a2 2 0 0 0-2 2" /></svg>;
}

function LinkIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M5.3 11.9l-1.2 1.2a2.8 2.8 0 0 1-4-4l2.2-2.2a2.8 2.8 0 0 1 4 0M10.7 4.1l1.2-1.2a2.8 2.8 0 0 1 4 4l-2.2 2.2a2.8 2.8 0 0 1-4 0" /></svg>;
}

function SendIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m2 2 12 6-12 6 2-6-2-6Zm2 6h10" /></svg>;
}
