import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
import { useWorkspaceStore } from "@/stores/workspace";
import { ElMessage } from "element-plus";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/hello",
    },
    {
      path: "/hello",
      beforeEnter: async () => await useHelloStore().load() ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      beforeEnter: async () => {
        const store = useWorkspaceStore();
        const id = store.project?.serverProjectId;
        if (!id) return true;
        try { await store.openServerProject(id); return true; }
        catch {
          store.project = null;
          store.pendingAgentMessage = null;
          ElMessage.error("无法访问已登记项目，请在服务器项目列表中重新确认");
          return "/home";
        }
      },
      component: () => import("@/pages/workspace/index.vue"),
    },
  ],
});
export default router;
