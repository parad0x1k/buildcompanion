import * as vscode from "vscode";

/** Minimal in-memory Memento used to satisfy `vscode.ExtensionContext.globalState` in tests. */
export class FakeMemento implements vscode.Memento {
    private readonly data = new Map<string, unknown>();

    public get<T>(key: string): T | undefined;
    public get<T>(key: string, defaultValue: T): T;
    public get<T>(key: string, defaultValue?: T): T | undefined {
        return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
    }

    public update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) {
            this.data.delete(key);
        } else {
            this.data.set(key, value);
        }
        return Promise.resolve();
    }

    public keys(): readonly string[] {
        return Array.from(this.data.keys());
    }

    public setKeysForSync(): void {
        // No-op: sync scoping is irrelevant for unit tests.
    }
}

/** Minimal in-memory SecretStorage used to satisfy `vscode.ExtensionContext.secrets` in tests. */
export class FakeSecretStorage implements vscode.SecretStorage {
    private readonly data = new Map<string, string>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
    public readonly onDidChange = this.changeEmitter.event;

    public async get(key: string): Promise<string | undefined> {
        return this.data.get(key);
    }

    public async store(key: string, value: string): Promise<void> {
        this.data.set(key, value);
        this.changeEmitter.fire({ key });
    }

    public async delete(key: string): Promise<void> {
        this.data.delete(key);
        this.changeEmitter.fire({ key });
    }
}

/**
 * Builds a structurally-minimal stand-in for `vscode.ExtensionContext`, covering only the
 * members this extension's command/service layer actually reads. Cast through `unknown` since
 * the real interface has many members (storage URIs, extension mode, etc.) that are irrelevant
 * to the logic under test.
 */
export function createFakeExtensionContext(): vscode.ExtensionContext {
    const subscriptions: { dispose(): unknown }[] = [];

    return {
        subscriptions,
        secrets: new FakeSecretStorage(),
        globalState: new FakeMemento(),
        workspaceState: new FakeMemento()
    } as unknown as vscode.ExtensionContext;
}

export function disposeFakeExtensionContext(context: vscode.ExtensionContext): void {
    for (const subscription of context.subscriptions.splice(0)) {
        subscription.dispose();
    }
}
