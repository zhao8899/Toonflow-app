# Toonflow 视频创作平台二次开发设计文档

**项目名称：** Toonflow 视频创作平台二次开发  
**设计日期：** 2026-10-17  
**设计版本：** 1.0  
**设计负责人：** Claude Sonnet 5.5

---

## 1. 项目概述

### 1.1 项目背景

Toonflow 是一个基于节点流程的视频创作平台，采用 Vue 3 + Bun + Electron 技术栈，支持插件化扩展。本次二次开发旨在全面提升平台的 AI 能力、性能、用户体验和商业化能力。

### 1.2 核心目标

1. **AI 能力增强**：集成 Seedance 2.5 等先进模型，提供图像和视频生成能力
2. **性能优化**：通过任务队列和 Worker Pool 提升视频处理并发能力
3. **用户体验改进**：优化编辑器交互、素材管理、预览播放等核心功能
4. **商业化功能**：建立用户认证、会员体系、Token 消费系统

### 1.3 技术约束

- **前端**：Vue 3 + TypeScript + Vite 8 + Element Plus
- **后端**：Bun + Express 5 + FFmpeg
- **桌面**：Electrobun 2.0
- **架构**：Monorepo (Workspace) + 插件化系统
- **兼容性**：保持与现有系统的完全兼容

### 1.4 成功标准

- 所有新功能按设计实现并通过测试
- 性能提升：视频处理速度提升 50%+，支持 4-8 并发任务
- 用户体验：编辑器响应时间 < 100ms，素材加载使用虚拟滚动
- 商业化：完整的用户认证、会员管理和计费系统

---

## 2. 技术架构设计

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        前端层 (Vue 3)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ 画布编辑器│  │ 素材管理  │  │ 预览播放  │  │ 用户中心  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP/WebSocket
┌────────────────────────┴────────────────────────────────────┐
│                    后端服务层 (Bun + Express)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ API 路由  │  │ 认证中间件│  │ 任务队列  │  │ MCP 服务  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                      核心能力层                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Provider  │  │ FFmpeg    │  │ Worker    │  │ Cache     │   │
│  │  系统     │  │  处理     │  │  Pool     │  │  管理     │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                    外部服务层                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ 道成云API │  │ 存储服务  │  │ CDN(可选) │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据流设计

**AI 生成流程：**
```
用户操作 → 前端节点 → API 请求 → 任务队列 → Worker 执行 
→ Provider 调用 → 道成云 API → 结果返回 → 写入缓存 → 前端显示
```

**视频渲染流程：**
```
画布保存 → 渲染请求 → 任务队列 → Worker Pool → FFmpeg 处理
→ 进度回报 → 前端轮询 → 完成通知 → 结果下载
```

---

## 3. 模块详细设计

## 3.1 Seedance 2.5 Provider 集成

### 3.1.1 模块概述

**目标：** 将道成云平台的 Seedance 2.5 模型集成到 Toonflow 的 Provider 系统中，支持图像和视频生成。

**实现方式：** 独立 Provider 模式，完全解耦，易于维护和扩展。

### 3.1.2 文件结构

```
packages/providers/src/media/
└── daochengCloud.ts        # 道成云 Provider 实现
```

### 3.1.3 核心接口设计

**Provider 定义：**
```typescript
// packages/providers/src/media/daochengCloud.ts

const rules = [
  {
    type: "input" as const,
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input" as const,
    field: "baseUrl" as const,
    title: "API Base URL",
    value: "https://ai.daochengyun.cn/v1",
    props: { placeholder: "API 端点地址" },
  },
] as const;

const provider: ProviderDefinition<typeof rules> = {
  id: "daocheng-cloud",
  label: "道成云",
  icon: "data:image/svg+xml;base64,...", // 道成云 Logo
  version: "1.0.0",
  apiUrl: "https://ai.daochengyun.cn/v1",
  protocol: "openai-completions",
  rules,
  models: [
    {
      id: "seedance-2.5-image",
      label: "Seedance 2.5 图像",
      type: "image",
      mode: ["text", "singleImage"],
      imageSizes: ["1024x1024", "1024x1792", "1792x1024"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    },
    {
      id: "seedance-2.5-video",
      label: "Seedance 2.5 视频",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired"],
      durationResolutionMap: [
        { duration: [5, 10, 15], resolution: ["720p", "1080p"] }
      ],
    }
  ],
  generateImage,
  generateVideo,
  getBalance,
  getPrice,
};

export default provider;
```

### 3.1.4 图像生成实现

```typescript
async function generateImage(
  this: ProviderContext<ProviderConfig<typeof rules>>,
  request: ImageRequest
): Promise<MediaAsset[]> {
  const { apiKey, baseUrl } = this.config;
  
  // 1. 构建请求参数
  const payload = {
    model: request.model,
    prompt: request.prompt,
    n: request.n || 1,
    size: request.size || "1024x1024",
    quality: request.quality || "standard",
    response_format: "url"
  };
  
  // 2. 处理参考图片
  if (request.images && request.images.length > 0) {
    payload.image = await uploadImage(
      this, apiKey, baseUrl, request.images[0], this.signal
    );
  }
  
  // 3. 调用 API
  const response = await this.tool.fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: this.signal
  });
  
  if (!response.ok) {
    throw new Error(this.tool.errorMessage(await response.text()));
  }
  
  // 4. 解析结果
  const result = await response.json();
  const assets: MediaAsset[] = [];
  
  for (const item of result.data) {
    const imageResponse = await this.tool.fetch(item.url, { 
      signal: this.signal 
    });
    const buffer = await imageResponse.arrayBuffer();
    
    assets.push({
      type: "binary",
      data: new Uint8Array(buffer),
      mimeType: "image/png",
      mediaType: "image"
    });
  }
  
  return assets;
}
```

### 3.1.5 视频生成实现

```typescript
async function generateVideo(
  this: ProviderContext<ProviderConfig<typeof rules>>,
  request: VideoRequest
): Promise<MediaAsset[]> {
  const { apiKey, baseUrl } = this.config;
  
  // 1. 构建请求参数
  const payload = {
    model: request.model,
    prompt: request.prompt,
    duration: request.duration || 5,
    resolution: request.resolution || "1080p",
    fps: 30
  };
  
  // 2. 处理首尾帧
  if (request.firstFrame) {
    payload.first_frame = await uploadImage(
      this, apiKey, baseUrl, request.firstFrame, this.signal
    );
  }
  
  if (request.lastFrame) {
    payload.last_frame = await uploadImage(
      this, apiKey, baseUrl, request.lastFrame, this.signal
    );
  }
  
  // 3. 提交生成任务
  const submitResponse = await this.tool.fetch(
    `${baseUrl}/videos/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: this.signal
  });
  
  if (!submitResponse.ok) {
    throw new Error(this.tool.errorMessage(await submitResponse.text()));
  }
  
  const submitResult = await submitResponse.json();
  const taskId = submitResult.id;
  
  // 4. 轮询任务状态
  while (true) {
    this.signal?.throwIfAborted();
    
    const statusResponse = await this.tool.fetch(
      `${baseUrl}/videos/generations/${taskId}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: this.signal
    });
    
    const statusData = await statusResponse.json();
    
    if (statusData.status === "completed") {
      const videoResponse = await this.tool.fetch(statusData.output_url, { 
        signal: this.signal 
      });
      const buffer = await videoResponse.arrayBuffer();
      
      return [{
        type: "binary",
        data: new Uint8Array(buffer),
        mimeType: "video/mp4",
        mediaType: "video"
      }];
    }
    
    if (statusData.status === "failed") {
      throw new Error(`视频生成失败：${statusData.error || "未知错误"}`);
    }
    
    // 等待 3 秒后重试
    await wait(this.signal, 3000);
  }
}
```

### 3.1.6 余额查询

```typescript
async function getBalance(
  this: ProviderContext<ProviderConfig<typeof rules>>
): Promise<ProviderBalance> {
  const { apiKey, baseUrl } = this.config;
  
  const response = await this.tool.fetch(
    `${baseUrl}/dashboard/billing/subscription`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
    signal: this.signal
  });
  
  if (!response.ok) {
    throw new Error(this.tool.errorMessage(await response.text()));
  }
  
  const data = await response.json();
  
  return {
    balance: data.balance || 0,
    unit: "积分",
    totalConsumption: data.total_usage,
    totalRecharge: data.total_granted
  };
}
```

### 3.1.7 价格估算

```typescript
async function getPrice(
  this: ProviderContext<ProviderConfig<typeof rules>>,
  request: ProviderPriceRequest
): Promise<ProviderPrice | null> {
  if (request.type === "image") {
    const basePrice = 10;
    const count = request.n || 1;
    
    return {
      price: `${basePrice * count} 积分`,
      tips: `${count} 张图片，每张 ${basePrice} 积分`
    };
  }
  
  if (request.type === "video") {
    const duration = request.duration || 5;
    const pricePerSecond = 5;
    
    return {
      price: `${duration * pricePerSecond} 积分`,
      tips: `${duration} 秒视频，每秒 ${pricePerSecond} 积分`
    };
  }
  
  return null;
}
```

### 3.1.8 辅助函数

```typescript
async function uploadImage(
  context: ProviderContext,
  apiKey: string,
  baseUrl: string,
  input: MediaInput,
  signal: AbortSignal
): Promise<string> {
  if (input.type === "url") {
    return input.url;
  }
  
  const bytes = input.type === "binary" 
    ? input.data 
    : Buffer.from(input.data, "base64");
  const ext = input.mimeType.split("/")[1] || "png";
  
  const formData = new FormData();
  formData.append(
    "file", 
    new Blob([bytes], { type: input.mimeType }), 
    `upload.${ext}`
  );
  
  const response = await context.tool.fetch(`${baseUrl}/files`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
    signal
  });
  
  if (!response.ok) {
    throw new Error(`图片上传失败：HTTP ${response.status}`);
  }
  
  const result = await response.json();
  return result.url;
}

function wait(signal: AbortSignal, ms: number): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
```

### 3.1.9 前端集成

**现有节点自动支持：**
- `imageGenerationNode` 将在 Provider 下拉列表中显示"道成云"
- `videoGenerationNode` 将在 Provider 下拉列表中显示"道成云"

**配置界面：**
- 设置页面自动生成 API Key 和 Base URL 输入框
- 保存后立即可用

---

## 3.2 商业化功能设计（混合架构）

### 3.2.1 模块概述

**目标：** 建立完整的用户认证、会员体系和 Token 消费系统，支持平台商业化运营。

**架构选择：** 配置文件 + JWT Token + 道成云计费集成

### 3.2.2 数据模型设计

**用户数据结构：**
```typescript
interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  membershipLevel: MembershipLevel;
  daochengApiKey?: string;
  createdAt: string;
  lastLoginAt: string;
  profile?: {
    avatar?: string;
    bio?: string;
  };
}

type MembershipLevel = "free" | "basic" | "pro" | "enterprise";

interface MembershipConfig {
  maxProjects: number;
  maxStorageGB: number;
  aiGenerationQuota: number;
  features: string[];
}

const MEMBERSHIP_LEVELS: Record<MembershipLevel, MembershipConfig> = {
  free: {
    maxProjects: 3,
    maxStorageGB: 1,
    aiGenerationQuota: 10,
    features: ["basic_editing"]
  },
  basic: {
    maxProjects: 10,
    maxStorageGB: 10,
    aiGenerationQuota: 100,
    features: ["basic_editing", "hd_export"]
  },
  pro: {
    maxProjects: 50,
    maxStorageGB: 50,
    aiGenerationQuota: 500,
    features: ["basic_editing", "hd_export", "ai_tools", "batch_processing"]
  },
  enterprise: {
    maxProjects: -1,
    maxStorageGB: 200,
    aiGenerationQuota: -1,
    features: ["all"]
  }
};
```

**配额记录结构：**
```typescript
interface QuotaUsage {
  userId: string;
  date: string;
  aiGenerationUsed: number;
  storageUsedGB: number;
  projectCount: number;
}
```

### 3.2.3 文件存储设计

**存储位置：** `data/` 目录（与 `settings.json` 同级）

```
data/
├── settings.json
├── users.json
└── quotas/
    └── YYYY-MM-DD.json
```

**users.json 结构：**
```json
{
  "users": {
    "user_abc123": {
      "id": "user_abc123",
      "username": "张三",
      "email": "zhangsan@example.com",
      "passwordHash": "$2a$10$...",
      "membershipLevel": "pro",
      "daochengApiKey": "sk-xxx",
      "createdAt": "2026-10-17T10:00:00Z",
      "lastLoginAt": "2026-10-17T15:30:00Z"
    }
  }
}
```

### 3.2.4 后端 API 设计

**路由结构：**
```
apps/server/src/routes/
├── auth/
│   ├── register.ts
│   ├── login.ts
│   ├── logout.ts
│   └── refresh.ts
├── user/
│   ├── profile.ts
│   ├── update.ts
│   ├── balance.ts
│   └── quota.ts
└── membership/
    ├── plans.ts
    ├── upgrade.ts
    └── features.ts
```

**核心实现示例（省略完整代码，关键逻辑）：**

1. **注册接口 (POST /api/auth/register)**
   - 校验：用户名 3-20 字符、邮箱格式、密码 ≥8 字符
   - 检查用户名和邮箱唯一性
   - BCrypt 加密密码
   - 生成 JWT Token（7 天有效期）
   - 默认会员等级：free

2. **登录接口 (POST /api/auth/login)**
   - BCrypt 验证密码
   - 更新最后登录时间
   - 返回用户信息和 Token

3. **认证中间件 (`authMiddleware`)**
   - 解析 `Authorization: Bearer <token>`
   - 验证 JWT 签名和有效期
   - 将用户信息注入 `req.user`

4. **会员权限中间件 (`requireFeature`)**
   - 检查当前会员等级是否支持指定功能
   - 不支持返回 403

### 3.2.5 配额管理

**QuotaManager 类核心方法：**

```typescript
class QuotaManager {
  async checkQuota(userId: string, type: "ai_generation"): Promise<boolean> {
    // 1. 获取用户会员配置
    // 2. 读取今日使用量
    // 3. 判断是否超限
  }
  
  async incrementQuota(userId: string, type: "ai_generation") {
    // 1. 读取今日配额文件
    // 2. 增加计数
    // 3. 保存回文件
  }
}
```

**存储格式：** `data/quotas/2026-10-17.json`
```json
{
  "user_abc123": {
    "userId": "user_abc123",
    "date": "2026-10-17",
    "aiGenerationUsed": 45,
    "storageUsedGB": 2.3,
    "projectCount": 5
  }
}
```

### 3.2.6 前端集成

**Pinia Store (`useUserStore`)**

核心状态和方法：
- `user`: 当前登录用户信息
- `token`: JWT Token
- `balance`: 道成云余额
- `isLoggedIn`: 是否已登录
- `membershipLabel`: 会员等级显示名称
- `login()`, `register()`, `logout()`
- `refreshBalance()`: 调用道成云 API 获取余额
- `checkFeature()`: 检查当前会员是否支持某功能

**持久化：** 使用 `pinia-plugin-persistedstate`，保存 `user` 和 `token` 到 LocalStorage

**登录页面：** `apps/web/src/views/auth/login.vue`
- 用户名 + 密码表单
- 登录成功后跳转到首页
- 提供注册链接

**用户中心：** `apps/web/src/views/user/profile.vue`
- 显示用户信息（用户名、邮箱、会员等级）
- 显示道成云余额和刷新按钮
- 显示配额使用情况（进度条）

### 3.2.7 计费集成

**方案：直接使用道成云计费**

用户在 Toonflow 中绑定道成云 API Key 后：
1. 所有 AI 生成操作直接调用道成云 API
2. 余额查询通过道成云 API 获取
3. 消费由道成云平台统一计费

**优点：**
- 无需本地维护复杂的计费逻辑
- 账单清晰，用户直接在道成云查看消费
- 减少数据不一致风险
- 简化系统架构

**本地配额限制：**
- Free/Basic/Pro 会员仍有每日生成次数限制（防止滥用）
- Enterprise 会员无本地限制，仅受道成云账户余额限制

---

## 3.3 性能优化设计（Bun Workers）

### 3.3.1 模块概述

**目标：** 通过任务队列和 Worker Pool 提升视频处理、AI 生成等耗时操作的并发能力。

**技术选型：** Bun Worker Threads + 内存队列

### 3.3.2 整体架构

```
┌──────────────────┐
│  Express Server  │
│  (Main Process)  │
└────────┬─────────┘
         │ enqueue
         ↓
┌────────────────────┐
│   Task Queue       │
│  (Memory Queue)    │
└────────┬───────────┘
         │ dispatch
         ↓
┌────────────────────┐
│   Worker Pool      │
│  (2-8 Workers)     │
└────────┬───────────┘
         │ execute
         ↓
┌────────────────────┐
│  FFmpeg / AI API   │
│  (Heavy Tasks)     │
└────────────────────┘
```

### 3.3.3 文件结构

```
packages/taskQueue/
├── package.json
├── index.ts
├── worker.ts
├── types.ts
└── handlers/
    ├── videoRender.ts
    ├── imageGen.ts
    └── videoGen.ts
```

### 3.3.4 任务类型定义

```typescript
export type TaskType = 
  | "video_render" 
  | "image_generation" 
  | "video_generation"
  | "audio_generation"
  | "export";

export type TaskStatus = 
  | "pending" 
  | "processing" 
  | "completed" 
  | "failed" 
  | "cancelled";

export interface Task {
  id: string;
  type: TaskType;
  payload: Record<string, unknown>;
  status: TaskStatus;
  priority: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  progress?: number;
  result?: unknown;
  error?: string;
  userId?: string;
}
```

### 3.3.5 任务队列核心逻辑

**TaskQueue 类：**

```typescript
class TaskQueue {
  private queue: Task[] = [];
  private processing = new Map<string, Task>();
  private completed = new Map<string, Task>();
  private workers: WorkerInstance[] = [];
  private maxWorkers = 8;
  
  async enqueue(
    type: TaskType,
    payload: Record<string, unknown>,
    priority = 5,
    userId?: string
  ): Promise<string> {
    // 1. 创建任务
    // 2. 加入队列并按优先级排序
    // 3. 触发调度
    // 4. 返回任务 ID
  }
  
  private dispatch() {
    // 1. 查找空闲 Worker
    // 2. 查找待处理任务
    // 3. 如果需要，动态创建新 Worker
    // 4. 分配任务给 Worker
  }
  
  private handleTaskComplete(instance, taskId, result) {
    // 1. 更新任务状态
    // 2. 移动到 completed 集合
    // 3. 通知监听器
    // 4. 释放 Worker
    // 5. 触发下一轮调度
  }
  
  async cancelTask(taskId: string): Promise<boolean> {
    // 1. 从队列移除
    // 2. 或终止正在执行的 Worker
  }
  
  subscribe(taskId: string, listener: (task: Task) => void) {
    // 订阅任务状态变化
  }
}
```

**动态 Worker 扩展：**
- 初始 Worker 数：2
- 最大 Worker 数：8
- 当有待处理任务且无空闲 Worker 时，自动创建新 Worker

### 3.3.6 Worker 实现

```typescript
// worker.ts
parentPort?.on("message", async (task: Task) => {
  try {
    let result;
    
    switch (task.type) {
      case "video_render":
        result = await handleVideoRender(task, reportProgress);
        break;
      case "image_generation":
        result = await handleImageGeneration(task, reportProgress);
        break;
      // ... 其他类型
    }
    
    parentPort?.postMessage({ type: "complete", taskId: task.id, result });
  } catch (error) {
    parentPort?.postMessage({ type: "error", taskId: task.id, error });
  }
});

function reportProgress(taskId: string, progress: number, message?: string) {
  parentPort?.postMessage({ type: "progress", taskId, progress, message });
}
```

### 3.3.7 后端 API

**任务提交：** `POST /api/tasks/submit`
- 接收 `type`、`payload`、`priority`
- 检查用户会员权限
- 检查配额
- 调用 `taskQueue.enqueue()`
- 返回 `taskId`

**任务状态查询：** `GET /api/tasks/status/:taskId`
- 返回任务状态、进度、结果或错误

**任务取消：** `DELETE /api/tasks/:taskId`
- 调用 `taskQueue.cancelTask()`

### 3.3.8 前端轮询

**useTaskPoller 组合式函数：**

```typescript
export function useTaskPoller(taskId: string) {
  const status = ref<string>("pending");
  const progress = ref<number>(0);
  const result = ref<any>(null);
  const error = ref<string | null>(null);
  
  async function poll() {
    // 调用 /api/tasks/status/:taskId
    // 更新状态
    // 如果完成或失败，停止轮询
  }
  
  function startPolling() {
    poll();
    interval = setInterval(poll, 1000);
  }
  
  onUnmounted(stopPolling);
  
  return { status, progress, result, error };
}
```

**使用示例：**
```vue
<template>
  <div class="taskProgress">
    <p>任务状态：{{ status }}</p>
    <el-progress :percentage="progress" />
  </div>
</template>

<script setup lang="ts">
import { useTaskPoller } from "@/lib/taskPoller";

const props = defineProps<{ taskId: string }>();
const { status, progress, result, error } = useTaskPoller(props.taskId);
</script>
```

### 3.3.9 缓存策略

**CacheManager 类：**

- **二级缓存：** 内存缓存（LRU，最多 100 条）+ 磁盘缓存
- **缓存键：** MD5 哈希（防止特殊字符）
- **TTL：** 默认 24 小时
- **驱逐策略：** LRU（Least Recently Used）
- **存储位置：** `data/cache/`

**方法：**
- `get<T>(key: string): Promise<T | null>`
- `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>`
- `delete(key: string): Promise<void>`
- `clear(): Promise<void>`
- `getStats(): Promise<CacheStats>`

---

## 3.4 用户体验优化

### 3.4.1 编辑器交互优化

**目标响应时间：** < 100ms

**优化措施：**

1. **节点拖拽优化**
   - 使用 CSS `transform` 代替 `position`
   - 开启 `will-change: transform`
   - 使用 `requestAnimationFrame`

2. **画布缩放/平移优化**
   - 防抖处理（300ms）
   - 仅在操作结束后重新渲染细节
   - 使用 Canvas 层实现高性能渲染

3. **节点连接线优化**
   - 使用 SVG `path` 代替多个 `div`
   - 缓存连接线路径计算结果
   - 仅在节点移动时重新计算

4. **撤销/重做优化**
   - 最多保留 50 步历史记录
   - 使用增量快照（Immer.js）
   - 异步保存历史记录

### 3.4.2 素材管理优化

**虚拟滚动实现：**

使用 `vue-virtual-scroller` 或手写虚拟列表：
- 仅渲染可见区域的素材卡片
- 预加载上下 5 个条目
- 支持动态高度（图片/视频不同高度）

**缩略图生成策略：**
- 图片：自动生成 200x200 缩略图（ImageMagick）
- 视频：提取第一帧作为缩略图（FFmpeg）
- 缓存到 `data/cache/thumbnails/`

**懒加载：**
- 使用 `IntersectionObserver` 监听卡片进入视口
- 仅加载可见卡片的缩略图

### 3.4.3 预览播放优化

**实时预览：**
- 使用 `<video>` 标签的 `timeupdate` 事件同步时间轴
- 防抖处理拖拽事件（50ms）
- 预加载下一秒视频帧

**导出优化：**
- 支持自定义分辨率（720p、1080p、4K）
- 支持自定义帧率（24fps、30fps、60fps）
- 支持自定义编码格式（H.264、H.265、VP9）
- 实时显示导出进度（FFmpeg 输出解析）

---

## 4. 实施计划

### 4.1 开发阶段

**阶段一：Seedance 2.5 Provider 集成（2-3 天）**
- Day 1: Provider 实现 + 图像生成 + 视频生成
- Day 2: 余额查询 + 价格估算 + 辅助函数
- Day 3: 前端集成测试 + 文档

**阶段二：商业化功能开发（4-5 天）**
- Day 1-2: 后端认证系统（注册、登录、JWT）
- Day 3: 配额管理 + 会员权限中间件
- Day 4: 前端用户 Store + 登录页面
- Day 5: 用户中心 + 余额查询集成

**阶段三：性能优化实施（3-4 天）**
- Day 1-2: 任务队列 + Worker Pool
- Day 3: 视频渲染 Handler + FFmpeg 集成
- Day 4: 缓存系统 + 前端轮询

**阶段四：用户体验优化（2-3 天）**
- Day 1: 编辑器交互优化
- Day 2: 素材管理虚拟滚动
- Day 3: 预览播放优化

**阶段五：测试与修复（2-3 天）**
- Day 1: 单元测试（ACT 不适用，仅手工验证）
- Day 2-3: 集成测试 + Bug 修复

**总计：13-18 天**

### 4.2 验证计划

**Seedance 2.5 Provider：**
- [ ] 图像生成成功（文生图、图生图）
- [ ] 视频生成成功（文生视频、图生视频、首尾帧控制）
- [ ] 余额查询正确
- [ ] 价格估算准确
- [ ] 错误处理完善（API 失败、网络超时、取消请求）

**商业化功能：**
- [ ] 用户注册成功
- [ ] 用户登录成功
- [ ] JWT Token 有效期正确（7 天）
- [ ] 会员权限验证正确
- [ ] 配额限制生效
- [ ] 道成云余额查询成功

**性能优化：**
- [ ] 视频渲染任务提交成功
- [ ] Worker Pool 正常工作（2-8 Workers）
- [ ] 任务进度实时更新
- [ ] 任务可取消
- [ ] 缓存正确命中
- [ ] 并发 4-8 个任务无阻塞

**用户体验：**
- [ ] 节点拖拽流畅（< 100ms）
- [ ] 素材列表虚拟滚动流畅
- [ ] 预览播放无卡顿
- [ ] 导出进度实时显示

### 4.3 部署计划

**开发环境：**
1. 确保 Bun 版本 ≥ 1.1.0
2. 确保 Electrobun 版本 ≥ 2.0.0
3. 安装 FFmpeg（系统级）
4. 配置道成云 API Key

**生产环境：**
1. 设置环境变量：
   - `JWT_SECRET`: 生产环境 JWT 密钥
   - `TOONFLOW_DATA_DIR`: 数据目录路径
2. 初始化数据目录：
   ```bash
   mkdir -p data/cache data/quotas
   touch data/users.json data/settings.json
   ```
3. 配置 Nginx 反向代理（可选）
4. 配置 CDN（可选）

---

## 5. 风险与挑战

### 5.1 技术风险

**Worker Pool 稳定性：**
- **风险：** Bun Worker Threads 是较新功能，可能存在未知 Bug
- **缓解：** 添加完善的错误处理和 Worker 重启机制

**FFmpeg 性能：**
- **风险：** 大量并发视频渲染可能导致 CPU/内存瓶颈
- **缓解：** 限制最大 Worker 数为 8，添加任务队列缓冲

**道成云 API 可用性：**
- **风险：** 外部 API 可能不稳定或限流
- **缓解：** 添加重试机制、降级提示、本地缓存

### 5.2 安全风险

**JWT Token 泄露：**
- **缓解：** 使用 HTTPS、设置 HttpOnly Cookie、定期刷新 Token

**配额绕过：**
- **缓解：** 后端强制校验、日志审计、异常检测

**文件上传安全：**
- **缓解：** 文件类型白名单、大小限制、病毒扫描

### 5.3 兼容性风险

**Electrobun 2.0 兼容性：**
- **风险：** 新版本 Electron 可能导致现有功能失效
- **缓解：** 完整的回归测试、渐进式升级

---

## 6. 后续扩展规划

### 6.1 短期扩展（1-3 个月）

1. **音频生成集成**
   - 集成道成云或其他音频生成 API
   - 支持文字转语音、音乐生成

2. **批量处理**
   - 批量导出多个项目
   - 批量应用模板

3. **协作功能**
   - 项目分享链接
   - 多人实时协作（WebSocket）

### 6.2 中期扩展（3-6 个月）

1. **插件市场**
   - 第三方 Provider 上传
   - 插件评分和评论

2. **模板商城**
   - 官方模板库
   - 用户分享模板

3. **云端同步**
   - 项目云端存储
   - 跨设备同步

### 6.3 长期扩展（6-12 个月）

1. **SaaS 版本**
   - 纯 Web 版（无需下载）
   - 云端渲染（不依赖本地 FFmpeg）

2. **移动端支持**
   - iOS/Android App
   - 移动端预览和简单编辑

3. **AI 助手**
   - 智能剪辑建议
   - 自动字幕生成
   - 智能配音

---

## 7. 总结

本设计文档详细规划了 Toonflow 视频创作平台的二次开发方案，涵盖以下核心模块：

1. **Seedance 2.5 Provider 集成：** 完整的图像和视频生成能力
2. **商业化功能：** 用户认证、会员体系、配额管理和道成云计费集成
3. **性能优化：** 基于 Bun Workers 的任务队列和 Worker Pool
4. **用户体验优化：** 编辑器交互、素材管理和预览播放优化

**技术亮点：**
- 独立 Provider 模式，易于扩展
- 混合架构（配置文件 + JWT + 外部计费），简单高效
- 动态 Worker Pool，自动伸缩
- 二级缓存，内存 + 磁盘
- 虚拟滚动，支持海量素材

**预期效果：**
- 视频处理速度提升 50%+
- 支持 4-8 并发任务
- 编辑器响应时间 < 100ms
- 完整的商业化能力

本设计遵循 **ACT 资深开发模式**，优先复用现有能力，最小化新增代码，保证系统简洁高效。

---

**附录：**
- [道成云 API 文档](https://ai.daochengyun.cn/docs)
- [Bun Worker Threads 文档](https://bun.sh/docs/api/workers)
- [Vue 3 Composition API 文档](https://vuejs.org/api/composition-api.html)
- [Element Plus 文档](https://element-plus.org/)

