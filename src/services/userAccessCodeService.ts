import { 
  doc, 
  getDoc, 
  setDoc, 
  deleteDoc, 
  deleteField,
  onSnapshot, 
  getDocFromServer,
  Unsubscribe 
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { UserAccessCode } from '../types';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Validates connectivity to Firestore at application boot
 */
export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
    return false;
  }
}

/**
 * Ensures user profile document exists in /users/{userId}
 */
export async function ensureUserProfile(userId: string, email: string, displayName?: string): Promise<void> {
  const path = `users/${userId}`;
  try {
    const userRef = doc(db, 'users', userId);
    const snap = await getDoc(userRef);
    const now = new Date().toISOString();

    if (!snap.exists()) {
      await setDoc(userRef, {
        email,
        displayName: displayName || email.split('@')[0],
        createdAt: now,
        updatedAt: now,
        lastLogin: now
      });
    } else {
      await setDoc(userRef, {
        updatedAt: now,
        lastLogin: now
      }, { merge: true });
    }
  } catch (err: unknown) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

/**
 * Stores the user's Fyers access code & token in Firestore against the user
 * Document: /users/{userId}/access_codes/current
 */
export async function saveUserAccessCode(
  userId: string,
  data: {
    accessToken: string;
    accessCode?: string;
    userEmail?: string;
    expiresAt?: number;
    isValid?: boolean;
    tokenType?: string;
    fyId?: string;
    source?: string;
  }
): Promise<UserAccessCode> {
  const path = `users/${userId}/access_codes/current`;
  try {
    const email = data.userEmail || auth.currentUser?.email || '';
    if (email) {
      await ensureUserProfile(userId, email, auth.currentUser?.displayName || undefined);
    }

    const now = new Date().toISOString();
    const docRef = doc(db, 'users', userId, 'access_codes', 'current');
    
    // Default expiration is 24 hours if not explicitly provided
    const expiresAt = data.expiresAt || (Date.now() + 24 * 60 * 60 * 1000);

    const payload: any = {
      userId,
      accessToken: data.accessToken.trim(),
      isValid: data.isValid !== undefined ? data.isValid : true,
      expiresAt,
      ...(email ? { userEmail: email } : {}),
      ...(data.fyId ? { fyId: data.fyId.trim() } : {}),
      ...(data.tokenType ? { tokenType: data.tokenType } : { tokenType: 'Bearer' }),
      ...(data.source ? { source: data.source } : { source: 'manual' }),
      updatedAt: now,
      createdAt: now
    };

    if (data.accessCode && data.accessCode.trim()) {
      payload.accessCode = data.accessCode.trim();
    } else {
      payload.accessCode = deleteField();
    }

    await setDoc(docRef, payload, { merge: true });
    return payload as UserAccessCode;
  } catch (err: unknown) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

/**
 * Clears single-use authCode from Firestore to prevent expired re-exchange attempts
 */
export async function clearUserAuthCode(userId: string): Promise<void> {
  if (!userId) return;
  const path = `users/${userId}/access_codes/current`;
  try {
    const docRef = doc(db, 'users', userId, 'access_codes', 'current');
    await setDoc(docRef, { accessCode: deleteField(), updatedAt: new Date().toISOString() }, { merge: true });
  } catch {
    // Non-blocking cleanup
  }
}

/**
 * Retrieves the user's stored access code from Firestore
 */
export async function getUserAccessCode(userId: string): Promise<UserAccessCode | null> {
  const path = `users/${userId}/access_codes/current`;
  try {
    const docRef = doc(db, 'users', userId, 'access_codes', 'current');
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      return null;
    }
    const data = snap.data() as UserAccessCode;
    // Check expiration
    if (data.expiresAt && Date.now() > data.expiresAt) {
      data.isValid = false;
    }
    return data;
  } catch (err: unknown) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

/**
 * Subscribes to real-time changes to the user's stored access code in Firestore
 */
export function subscribeToUserAccessCode(
  userId: string,
  onUpdate: (data: UserAccessCode | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `users/${userId}/access_codes/current`;
  const docRef = doc(db, 'users', userId, 'access_codes', 'current');

  return onSnapshot(
    docRef,
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null);
        return;
      }
      const data = snap.data() as UserAccessCode;
      if (data.expiresAt && Date.now() > data.expiresAt) {
        data.isValid = false;
      }
      onUpdate(data);
    },
    (err) => {
      console.error(`Error in access code subscription on ${path}:`, err);
      if (onError) {
        try {
          handleFirestoreError(err, OperationType.GET, path);
        } catch (e: any) {
          onError(e);
        }
      }
    }
  );
}

/**
 * Deletes / Revokes the user's access code in Firestore
 */
export async function deleteUserAccessCode(userId: string): Promise<void> {
  const path = `users/${userId}/access_codes/current`;
  try {
    const docRef = doc(db, 'users', userId, 'access_codes', 'current');
    await deleteDoc(docRef);
  } catch (err: unknown) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

/**
 * Syncs the Firestore access code with the active backend trading session
 */
export async function syncAccessCodeWithServer(
  userTokenData: UserAccessCode | null | undefined,
  idToken?: string,
  retries: number = 2
): Promise<{ success: boolean; message?: string; error?: string; auth?: any; data?: any; clearAuthCode?: boolean }> {
  if (!userTokenData?.accessToken && !userTokenData?.accessCode) {
    return { success: false, error: 'No access code or token to sync' };
  }

  const userId = userTokenData.userId || auth.currentUser?.uid || '';
  const userEmail = userTokenData.userEmail || auth.currentUser?.email || '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': userId,
    'X-User-Email': userEmail
  };

  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }

  const payload = {
    ...userTokenData,
    userId,
    userEmail
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch('/api/user/access-code', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { success: false, error: `Server status ${res.status}: ${errText}` };
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        return data;
      }
      return { success: true, message: 'Access code synced' };
    } catch (err: any) {
      if (attempt < retries) {
        // Wait before retry in case server was restarting or waking up
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
        continue;
      }
      console.warn('Syncing Firestore access code with server notice (network state):', err?.message || err);
      return { success: false, error: err?.message || 'Sync failed' };
    }
  }

  return { success: false, error: 'Sync failed' };
}
