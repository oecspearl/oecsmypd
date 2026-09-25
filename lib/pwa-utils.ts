/**
 * PWA Utility Functions
 * Helper functions for Progressive Web App features
 */

// Check if PWA is installed
export function isPWAInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  
  // Check if running in standalone mode
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  
  // Check if running in fullscreen mode
  if (window.matchMedia('(display-mode: fullscreen)').matches) {
    return true;
  }
  
  // Check for iOS standalone mode
  if ((window.navigator as any).standalone === true) {
    return true;
  }
  
  return false;
}

// Check if install prompt is available
export function isInstallPromptAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return 'BeforeInstallPromptEvent' in window;
}

// Get the install prompt event
let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function setDeferredPrompt(event: BeforeInstallPromptEvent) {
  deferredPrompt = event;
}

export function getDeferredPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function clearDeferredPrompt() {
  deferredPrompt = null;
}

// Trigger install prompt
export async function triggerInstallPrompt(): Promise<boolean> {
  if (!deferredPrompt) {
    return false;
  }

  try {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    clearDeferredPrompt();
    return outcome === 'accepted';
  } catch (error) {
    console.error('Error triggering install prompt:', error);
    return false;
  }
}

// Check online/offline status
export function isOnline(): boolean {
  if (typeof window === 'undefined') return true;
  return navigator.onLine;
}

// Register service worker
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
    });

    console.log('[PWA] Service Worker registered:', registration.scope);

    // Check for updates
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (newWorker) {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New service worker available
            console.log('[PWA] New service worker available');
          }
        });
      }
    });

    return registration;
  } catch (error) {
    console.error('[PWA] Service Worker registration failed:', error);
    return null;
  }
}

// Clear every Cache Storage entry (service worker + page). Used on sign-out so
// no user-specific response survives into the next session on a shared device.
export async function clearPwaCaches(): Promise<void> {
  if (typeof window === 'undefined') return;

  // Ask the active service worker to clear its caches.
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.controller?.postMessage({ type: 'CLEAR_CACHES' });
    }
  } catch (error) {
    console.warn('[PWA] Could not message service worker:', error);
  }

  // Belt and braces: delete from the page as well (works even without a controller).
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn('[PWA] Could not clear caches from page:', error);
  }
}

// Unregister service worker (for testing/rollback)
export async function unregisterServiceWorker(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await registration.unregister();
      console.log('[PWA] Service Worker unregistered');
      return true;
    }
    return false;
  } catch (error) {
    console.error('[PWA] Service Worker unregistration failed:', error);
    return false;
  }
}

// Check if service worker is registered
export async function isServiceWorkerRegistered(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!registration;
  } catch (error) {
    return false;
  }
}

// Get service worker registration
export async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    return await navigator.serviceWorker.getRegistration();
  } catch (error) {
    return null;
  }
}

// Type definition for BeforeInstallPromptEvent
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}


