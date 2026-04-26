type ApplyUpdate = () => void
type UpdateReadyCallback = (applyUpdate: ApplyUpdate) => void

const updateReadyCallbacks = new Set<UpdateReadyCallback>()

let registrationStarted = false
let persistentStorageStarted = false
let pendingUpdate: ApplyUpdate | null = null
let reloadingForUpdate = false

function emitUpdateReady(applyUpdate: ApplyUpdate) {
  pendingUpdate = applyUpdate
  updateReadyCallbacks.forEach((callback) => callback(applyUpdate))
}

function createApplyUpdate(worker: ServiceWorker): ApplyUpdate {
  return () => {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForUpdate) return
      reloadingForUpdate = true
      window.location.reload()
    })
    worker.postMessage({ type: 'SKIP_WAITING' })
  }
}

async function registerServiceWorker() {
  if (registrationStarted || !('serviceWorker' in navigator)) return
  registrationStarted = true

  const base = import.meta.env.BASE_URL
  const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base })

  if (registration.waiting && navigator.serviceWorker.controller) {
    emitUpdateReady(createApplyUpdate(registration.waiting))
  }

  registration.addEventListener('updatefound', () => {
    const installingWorker = registration.installing
    if (!installingWorker) return

    installingWorker.addEventListener('statechange', () => {
      if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
        emitUpdateReady(createApplyUpdate(installingWorker))
      }
    })
  })
}

async function requestPersistentStorage() {
  if (persistentStorageStarted || !navigator.storage?.persisted || !navigator.storage.persist) return
  persistentStorageStarted = true

  try {
    const alreadyPersisted = await navigator.storage.persisted()
    if (!alreadyPersisted) {
      await navigator.storage.persist()
    }
  } catch {
    // Browsers can deny or omit this capability; local storage still works.
  }
}

export function subscribeToPwaUpdates(callback: UpdateReadyCallback): () => void {
  updateReadyCallbacks.add(callback)
  if (pendingUpdate) callback(pendingUpdate)

  if (document.readyState === 'complete') {
    void registerServiceWorker()
    void requestPersistentStorage()
  } else {
    window.addEventListener('load', () => {
      void registerServiceWorker()
      void requestPersistentStorage()
    }, { once: true })
  }

  return () => {
    updateReadyCallbacks.delete(callback)
  }
}
