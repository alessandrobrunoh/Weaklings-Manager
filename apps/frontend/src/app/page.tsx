"use client";

export default function Home() {
  const handleDiscordSignIn = () => {
    // 1. Recupera l'URL base (o usa il fallback locale)
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api";

    // 2. Costruisci l'URL di destinazione combinando la base con l'endpoint di login
    let targetUrl = apiBaseUrl.startsWith("http")
      ? `${apiBaseUrl}/auth/discord/login`
      : `http://localhost:3000${apiBaseUrl}/auth/discord/login`;

    // 3. Pulisce eventuali doppi slash generati per errore (es: api//auth)
    targetUrl = targetUrl.replace(/([^:]\/)\/+/g, "$1");

    // 4. Log di debug visibile nella console del browser (F12)
    console.log("Reindirizzamento a:", targetUrl);

    // 5. Esegue il reindirizzamento
    window.location.href = targetUrl;
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <main
        id="home"
        className="mx-auto flex min-h-[calc(100vh-73px)] w-full max-w-5xl flex-col items-center justify-center px-6 py-16 lg:px-8"
      >
        <div className="flex w-full max-w-2xl flex-col items-center text-center">
          <div className="space-y-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-500">
              Discord sign-in
            </p>
            <h1 className="whitespace-nowrap text-4xl font-semibold tracking-tight sm:text-5xl">
              Log in with Discord and continue.
            </h1>
            <p className="mx-auto max-w-xl text-lg text-zinc-600 dark:text-zinc-300">
              Use your Discord account to securely access your workspace and
              join the community.
            </p>
          </div>

          <div className="mt-8 w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-6 flex items-center justify-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm dark:bg-zinc-950">
                <img src="/assets/images/Discord-Symbol-Black.png" alt="Discord logo" className="h-6 w-8 dark:hidden" />
                <img src="/assets/images/Discord-Symbol-White.png" alt="Discord logo" className="hidden h-6 w-8 dark:block" />
              </div>
              <div className="text-left">
                <h2 className="text-xl font-semibold">Continue with Discord</h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Fast, secure sign-in
                </p>
              </div>
            </div>

            <div className="flex justify-center">
              <button
                onClick={handleDiscordSignIn}
                className="flex w-2/4 min-w-[140px] items-center justify-center rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500"
              >
                Sign in
              </button>
            </div>

            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
              By continuing, you agree to use your Discord account for
              authentication.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
