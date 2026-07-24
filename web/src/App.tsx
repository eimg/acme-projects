import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Board, Card, CardComment, ColumnId, Project } from "../../src/types";
import { api, formatTime } from "./api";

type Dialog = "project" | "edit-project" | "card" | null;

export function App() {
  const queryClient = useQueryClient();
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
  });

  return (
    <div className="app-shell">
      <Header onNewProject={() => setDialog("project")} />
      <div className="workspace">
        <ProjectSidebar
          projects={projects.data ?? []}
          selectedId={selectedProjectId}
          onSelect={setSelectedProjectId}
          onNew={() => setDialog("project")}
        />
        <main className="main-content">
          {projects.isLoading ? (
            <CenteredMessage title="Opening your workspace…" />
          ) : !projects.data?.length ? (
            <Welcome onCreate={() => setDialog("project")} />
          ) : board.data ? (
            <>
              <BoardHeader
                project={board.data.project}
                cardCount={board.data.columns.reduce((sum, column) => sum + column.cards.length, 0)}
                onEdit={() => setDialog("edit-project")}
                onDelete={() => {
                  if (confirm(`Delete “${board.data.project.name}” and all of its cards?`)) {
                    deleteProject.mutate(board.data.project.id);
                  }
                }}
              />
              <ProjectBoard
                board={board.data}
                onCard={setSelectedCardId}
                onNewCard={(columnId) => {
                  setNewCardColumn(columnId);
                  setDialog("card");
                }}
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

      {dialog === "project" && (
        <NewProjectDialog
          onClose={() => setDialog(null)}
          onCreated={(project) => {
            setDialog(null);
            setSelectedProjectId(project.id);
            showToast("Project created");
          }}
        />
      )}
      {dialog === "edit-project" && board.data && (
        <ProjectSettingsDialog
          project={board.data.project}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            showToast("Project settings saved");
          }}
        />
      )}
      {dialog === "card" && selectedProjectId && (
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

function Header({ onNewProject }: { onNewProject: () => void }) {
  return (
    <header className="app-header">
      <div className="brand">
        <BrandMark />
        <div className="brand-copy">
          <strong>Acme Projects</strong>
          <span>Shape ideas into work worth doing</span>
        </div>
      </div>
      <button className="button primary" onClick={onNewProject}>
        <PlusIcon /> New project
      </button>
    </header>
  );
}

function ProjectSidebar({
  projects,
  selectedId,
  onSelect,
  onNew,
}: {
  projects: Project[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
}) {
  return (
    <aside className="project-sidebar">
      <div className="sidebar-heading">
        <span>Projects</span>
        <button className="icon-button" onClick={onNew} aria-label="New project"><PlusIcon /></button>
      </div>
      <nav className="project-list">
        {projects.map((project) => (
          <button
            key={project.id}
            className={`project-link ${project.id === selectedId ? "active" : ""}`}
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
      <div className="sidebar-note">
        <SparkIcon />
        <p><strong>Explore first.</strong> Ready cards can be submitted to Acme Issues when a human chooses.</p>
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
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <section className="board-header">
      <div>
        <div className="eyebrow">Project board</div>
        <h1>{project.name}</h1>
        <p>{project.description || "A shared space for ideas, decisions, and implementation intent."}</p>
        <div className={`repository-scope ${project.repositoryPath ? "" : "unset"}`}>
          <RepoIcon />
          {project.repositoryPath || "Repository not set"}
        </div>
        <div className={`repository-scope ${project.issuesUrl ? "" : "unset"}`}>
          <LinkIcon />
          {project.issuesUrl || "Acme Issues not configured"}
        </div>
      </div>
      <div className="board-meta">
        <span>{cardCount} {cardCount === 1 ? "card" : "cards"}</span>
        <button className="text-button" onClick={onEdit}>Project settings</button>
        <button className="text-button danger" onClick={onDelete}>Delete project</button>
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
  onNewCard: (columnId: ColumnId) => void;
  onToast: (message: string) => void;
}) {
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
            onDragOver={(event) => event.preventDefault()}
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
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.stopPropagation();
                    drop(event, column.id, index);
                  }}
                >
                  <BoardCard
                    card={card}
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
            {column.id !== "in_progress" && column.id !== "in_review" && column.id !== "done" && (
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
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  card: Card;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <article
      className={`board-card ${dragging ? "dragging" : ""}`}
      draggable
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
          });
        }}
      >
        <Field label="Project name">
          <input name="name" autoFocus required placeholder="e.g. Customer workspace" />
        </Field>
        <Field label="Short description" hint="What space does this project create?">
          <textarea name="description" rows={3} placeholder="Explore a simpler way for customers to…" />
        </Field>
        <Field label="Repository path" hint="Optional. Cards in this project inherit this future execution scope.">
          <input name="repositoryPath" placeholder="/path/to/repository" />
        </Field>
        <Field label="Acme Issues URL" hint="Used only when you explicitly submit a Ready card.">
          <input
            name="issuesUrl"
            type="url"
            defaultValue="http://127.0.0.1:8320"
            placeholder="http://127.0.0.1:8320"
          />
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
          });
        }}
      >
        <Field label="Project name">
          <input name="name" defaultValue={project.name} autoFocus required />
        </Field>
        <Field
          label="Acme Issues URL"
          hint="Submitting a Ready card creates a non-triggering issue at this service."
        >
          <input
            name="issuesUrl"
            type="url"
            defaultValue={project.issuesUrl}
            placeholder="http://127.0.0.1:8320"
          />
        </Field>
        <Field label="Short description">
          <textarea name="description" rows={3} defaultValue={project.description} />
        </Field>
        <Field
          label="Repository path"
          hint="Optional until integration. Future implementation work will run in this repository."
        >
          <input
            name="repositoryPath"
            defaultValue={project.repositoryPath}
            placeholder="/path/to/repository"
          />
        </Field>
        <div className="scope-note">
          <SparkIcon />
          <span>One project, one repository. Cards inherit this path rather than selecting their own target.</span>
        </div>
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
      onToast(`Created Acme Issues issue #${result.card.activeImplementation?.issueId}`);
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
                if (confirm("Create a non-triggering implementation issue in Acme Issues?")) {
                  submitIssue.mutate();
                }
              }}
              onReturn={() => {
                if (confirm("Close the linked issue and return this card to Exploring?")) {
                  returnToExploration.mutate();
                }
              }}
            />
          )}
          <Field label="The idea" hint="Keep the current shared understanding here.">
            <textarea
              rows={6}
              value={draft.description ?? ""}
              onChange={(event) => update("description", event.target.value)}
              placeholder="What are we exploring, and why might it matter?"
            />
          </Field>
          <div className="detail-grid">
            <Field label="Decisions">
              <textarea
                rows={5}
                value={draft.decisions ?? ""}
                onChange={(event) => update("decisions", event.target.value)}
                placeholder="What have we agreed?"
              />
            </Field>
            <Field label="Open questions">
              <textarea
                rows={5}
                value={draft.openQuestions ?? ""}
                onChange={(event) => update("openQuestions", event.target.value)}
                placeholder="What still needs an answer?"
              />
            </Field>
          </div>
          <Field label="Acceptance notes" hint="What would make the implemented result feel complete?">
            <textarea
              rows={4}
              value={draft.acceptanceNotes ?? ""}
              onChange={(event) => update("acceptanceNotes", event.target.value)}
              placeholder="Describe a successful outcome…"
            />
          </Field>
          <FormError error={save.error} />
          <div className="detail-actions">
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
          </div>
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
}: {
  card: Card;
  project: Project;
  submitting: boolean;
  withdrawing: boolean;
  error: Error | null;
  onSubmit: () => void;
  onReturn: () => void;
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
            {" "}was created without the <code>{attempt.triggerLabel}</code> label. Add it in Acme Issues when ready.
          </p>
          <FormError error={error} />
          <button className="button ghost small" disabled={withdrawing} onClick={onReturn}>
            {withdrawing ? "Withdrawing…" : "Return to exploration"}
          </button>
        </div>
      </section>
    );
  }

  const missing = [
    !project.repositoryPath && "repository path",
    !project.issuesUrl && "Acme Issues URL",
  ].filter(Boolean);
  return (
    <section className="implementation-panel">
      <div className="implementation-icon"><SendIcon /></div>
      <div className="implementation-copy">
        <span className="eyebrow">Ready for implementation</span>
        <strong>Submit as an issue</strong>
        <p>
          This creates an Acme Issues issue labeled <code>acme-projects</code>.
          It will not trigger Helix until a human adds Acme Issues&apos; configured trigger label.
        </p>
        {missing.length > 0 && (
          <p className="configuration-warning">Set the {missing.join(" and ")} in Project settings first.</p>
        )}
        <FormError error={error} />
        <button
          className="button primary small"
          disabled={submitting || missing.length > 0 || !card.title.trim()}
          onClick={onSubmit}
        >
          <SendIcon /> {submitting ? "Submitting…" : "Submit as issue"}
        </button>
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
  const [body, setBody] = useState("");
  const mutation = useMutation({
    mutationFn: () => api<CardComment>(`/api/cards/${cardId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, author: "You" }),
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
      <form
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
      </form>
    </aside>
  );
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="welcome">
      <div className="welcome-art" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="eyebrow">A place to think together</div>
      <h1>Start with an idea,<br />not a ticket.</h1>
      <p>Create a project board to explore possibilities, record decisions, and shape work before implementation begins.</p>
      <button className="button primary large" onClick={onCreate}><PlusIcon /> Create your first project</button>
    </section>
  );
}

function CenteredMessage({ title, body }: { title: string; body?: string }) {
  return <div className="centered-message"><strong>{title}</strong>{body && <p>{body}</p>}</div>;
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
