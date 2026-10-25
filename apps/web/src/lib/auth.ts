import { createApp, ref } from "vue";
import loginForm from "@/components/loginForm.vue";

export const authRequired = ref(false);
export const userRole = ref<"admin" | "user">("admin");

async function readSession() {
  const session = await fetch("/api/auth/session", { cache: "no-store" });
  if (session.ok) userRole.value = (await session.json()).data?.role === "user" ? "user" : "admin";
  return session;
}

export async function ensureAuthenticated() {
  const response = await fetch("/api/auth/status", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取登录配置，请重试");
  const body = await response.json();
  authRequired.value = body.data?.required === true;
  if (!authRequired.value) return;
  const session = await readSession();
  if (session.ok) return;
  if (![401, 403].includes(session.status)) throw new Error("无法校验登录状态，请重试");
  await new Promise<void>(resolve => {
    const loginApp = createApp(loginForm, {
      onAuthenticated: () => {
        loginApp.unmount();
        resolve();
      },
    });
    loginApp.mount("#app");
  });
  if (!(await readSession()).ok) throw new Error("无法校验登录状态，请重试");
}
