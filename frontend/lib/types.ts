export type Role = "admin" | "user";

export interface UserDoc {
  email: string;
  displayName?: string;
  role: Role;
  orgId?: string;
  createdAt?: unknown;
}

export interface OrgDoc {
  id: string;
  name: string;
  createdAt?: unknown;
}

export interface ModelDoc {
  id: string;
  displayName: string;
  description?: string;
  storageFile?: string;
  downloadUrl?: string;
  sha256?: string;
  metrics?: { accuracy?: number; f1?: number };
  fidelity?: string;
  orgIds: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InvitationDoc {
  id: string;
  email: string;
  orgId: string;
  role: Role;
  status: "sent" | "accepted";
  sentAt?: unknown;
}
