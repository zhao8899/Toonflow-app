import conf from "@/utils/conf";
import { randomBytes, randomUUID, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import type { UserInfo, UserQuota, UserData, UserAuditEvent } from "./types";
import { UserStatus, UserRole } from "./types";

/** 密码加密迭代次数 */
const passwordIterations = 100000;

/** 密码哈希长度（字节） */
const hashLength = 32;

/** 盐值长度（字节） */
const saltLength = 16;

/** 生成密码哈希 */
function hashPassword(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, passwordIterations, hashLength, "sha256");
}

/** 验证密码 */
function verifyPassword(password: string, salt: Buffer, hash: Buffer): boolean {
  const computed = hashPassword(password, salt);
  return computed.length === hash.length && timingSafeEqual(computed, hash);
}

/** 用户管理类 */
class UserManager {
  private recordAudit(data: UserData, action: UserAuditEvent["action"], target: UserInfo, actorId?: string, previousStatus?: UserStatus): void {
    const actor = actorId && Object.hasOwn(data.users, actorId) ? data.users[actorId] : undefined;
    if (actorId && !actor) throw new Error("操作账号不存在");
    const event: UserAuditEvent = {
      id: randomUUID(), createdAt: new Date().toISOString(), action,
      actor: actor ? { id: actor.id, username: actor.username } : null,
      target: { id: target.id, username: target.username },
      ...(action === "statusChanged" ? { previousStatus, status: target.status } : {}),
    };
    // ACT: 与账号变更一起保存配置快照；小团队仅保留最近 1000 条，长期审计需迁移独立存储。
    data.auditEvents = [event, ...(data.auditEvents ?? [])].slice(0, 1000);
  }

  /** 获取用户数据 */
  private getUserData(): UserData {
    return conf.get("userData", {
      users: {},
      quotas: {},
      usernameIndex: {},
    }) as UserData;
  }

  /** 保存用户数据 */
  private saveUserData(data: UserData): void {
    conf.set("userData", data);
  }

  /** 获取用户密码数据 */
  private getPasswordData(): Record<string, { salt: string; hash: string }> {
    return conf.get("userPasswords", {}) as Record<string, { salt: string; hash: string }>;
  }

  /** 生成唯一用户 ID */
  private generateUserId(): string {
    return `user_${Date.now()}_${randomBytes(8).toString("hex")}`;
  }

  /** 注册新用户 */
  register(username: string, password: string, email?: string, role = UserRole.user, actorId?: string): UserInfo {
    const userData = this.getUserData();

    // 检查用户名是否已存在
    if (Object.hasOwn(userData.usernameIndex, username)) {
      throw Object.assign(new Error("用户名已存在"), { status: 409 });
    }

    // 生成密码哈希
    if (username === "__proto__" || username === "constructor" || username === "prototype") {
      throw Object.assign(new Error("请使用其他用户名"), { status: 400 });
    }
    const salt = randomBytes(saltLength);
    const hash = hashPassword(password, salt);

    const userId = this.generateUserId();
    const now = new Date();

    const user: UserInfo = {
      id: userId,
      username,
      email,
      role,
      status: UserStatus.active,
      sessionVersion: 0,
      createdAt: now,
    };

    // 保存用户信息
    userData.users[userId] = user;
    userData.usernameIndex[username] = userId;
    userData.quotas[userId] = [];
    // 保存密码
    const passwordData = this.getPasswordData();
    passwordData[userId] = {
      salt: salt.toString("hex"),
      hash: hash.toString("hex"),
    };
    // 公开注册不记录；管理员创建成员时记录操作者。
    if (role === UserRole.admin) this.recordAudit(userData, "administratorCreated", user, actorId);
    else if (actorId) this.recordAudit(userData, "memberCreated", user, actorId);
    // ACT: conf 的对象形式一次保存整个快照，避免用户与密码分次落盘。
    conf.set({ userData, userPasswords: passwordData });

    return user;
  }

  hasAdministrator(): boolean {
    return Object.values(this.getUserData().users).some(user => user.role === UserRole.admin);
  }

  listUsers(offset: number, limit: number) {
    // ACT: 当前配置存储适用于小团队，分页仅限制响应体；账号规模扩大后迁移数据库索引。
    const users = Object.values(this.getUserData().users).sort((left, right) => left.username.localeCompare(right.username));
    return {
      total: users.length,
      users: users.slice(offset, offset + limit).map(({ id, username, role, status, createdAt, lastLoginAt }) =>
        ({ id, username, role, status, createdAt, lastLoginAt })),
    };
  }

  listAuditEvents(offset: number, limit: number) {
    const events = this.getUserData().auditEvents ?? [];
    return { total: events.length, events: events.slice(offset, offset + limit) };
  }

  /** 用户登录验证 */
  login(username: string, password: string): UserInfo {
    const userData = this.getUserData();
    const userId = Object.hasOwn(userData.usernameIndex, username) ? userData.usernameIndex[username] : undefined;

    if (!userId) {
      throw Object.assign(new Error("用户名或密码错误，或账号不可用"), { status: 401 });
    }

    const user = userData.users[userId];
    if (!user) {
      throw Object.assign(new Error("用户名或密码错误，或账号不可用"), { status: 401 });
    }

    if (user.status !== UserStatus.active) {
      throw Object.assign(new Error("用户名或密码错误，或账号不可用"), { status: 401 });
    }

    // 验证密码
    const passwordData = this.getPasswordData();
    const stored = passwordData[userId];

    if (!stored) {
      throw Object.assign(new Error("用户名或密码错误，或账号不可用"), { status: 401 });
    }

    const salt = Buffer.from(stored.salt, "hex");
    const hash = Buffer.from(stored.hash, "hex");

    if (!verifyPassword(password, salt, hash)) {
      throw Object.assign(new Error("用户名或密码错误，或账号不可用"), { status: 401 });
    }

    // 更新最后登录时间
    user.lastLoginAt = new Date();
    userData.users[userId] = user;
    this.saveUserData(userData);

    return user;
  }

  /** 根据 ID 获取用户 */
  getUserById(userId: string): UserInfo | null {
    const userData = this.getUserData();
    return Object.hasOwn(userData.users, userId) ? userData.users[userId] ?? null : null;
  }

  /** 根据用户名获取用户 */
  getUserByUsername(username: string): UserInfo | null {
    const userData = this.getUserData();
    const userId = Object.hasOwn(userData.usernameIndex, username) ? userData.usernameIndex[username] : undefined;
    return userId ? userData.users[userId] || null : null;
  }

  /** 获取用户在指定 provider 的配额 */
  getUserQuota(userId: string, providerId: string): UserQuota | null {
    const userData = this.getUserData();
    const quotas = userData.quotas[userId] || [];
    return quotas.find((q) => q.providerId === providerId) || null;
  }

  /** 设置用户配额 */
  setUserQuota(userId: string, quota: Omit<UserQuota, "userId" | "updatedAt">): void {
    const userData = this.getUserData();

    if (!userData.users[userId]) {
      throw new Error("用户不存在");
    }

    const quotas = userData.quotas[userId] || [];
    const index = quotas.findIndex((q) => q.providerId === quota.providerId);

    const newQuota: UserQuota = {
      userId,
      ...quota,
      updatedAt: new Date(),
    };

    if (index >= 0) {
      quotas[index] = newQuota;
    } else {
      quotas.push(newQuota);
    }

    userData.quotas[userId] = quotas;
    this.saveUserData(userData);
  }

  /** 获取用户所有配额 */
  getUserQuotas(userId: string): UserQuota[] {
    const userData = this.getUserData();
    return userData.quotas[userId] || [];
  }

  /** 消耗用户配额 */
  consumeQuota(userId: string, providerId: string, amount: number): void {
    const quota = this.getUserQuota(userId, providerId);

    if (!quota) {
      throw new Error("用户配额不存在");
    }

    if (quota.remaining < amount) {
      throw new Error("配额不足");
    }

    quota.remaining -= amount;
    quota.updatedAt = new Date();

    const userData = this.getUserData();
    const quotas = userData.quotas[userId] || [];
    const index = quotas.findIndex((q) => q.providerId === providerId);

    if (index >= 0) {
      quotas[index] = quota;
      userData.quotas[userId] = quotas;
      this.saveUserData(userData);
    }
  }

  /** 验证当前密码后，一次保存新密码并撤销全部旧会话。 */
  changePassword(userId: string, currentPassword: string, newPassword: string): void {
    const userData = this.getUserData();
    const user = Object.hasOwn(userData.users, userId) ? userData.users[userId] : undefined;
    if (!user || user.status !== UserStatus.active) {
      throw Object.assign(new Error("账号不可用，请重新登录"), { status: 401 });
    }
    const passwordData = this.getPasswordData();
    const stored = passwordData[userId];
    if (!stored || !verifyPassword(currentPassword, Buffer.from(stored.salt, "hex"), Buffer.from(stored.hash, "hex"))) {
      throw Object.assign(new Error("当前密码不正确"), { status: 400 });
    }
    if (currentPassword === newPassword) {
      throw Object.assign(new Error("新密码不能与当前密码相同"), { status: 400 });
    }
    const salt = randomBytes(saltLength);
    passwordData[userId] = { salt: salt.toString("hex"), hash: hashPassword(newPassword, salt).toString("hex") };
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    this.recordAudit(userData, "passwordChanged", user, userId);
    conf.set({ userData, userPasswords: passwordData });
  }

  /** 撤销该账号所有已签发的会话 */
  revokeSessions(userId: string): void {
    const userData = this.getUserData();
    const user = Object.hasOwn(userData.users, userId) ? userData.users[userId] : undefined;
    if (!user) throw new Error("用户不存在");
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    this.recordAudit(userData, "sessionsRevoked", user, userId);
    this.saveUserData(userData);
  }

  /** 更新用户状态 */
  updateUserStatus(userId: string, status: UserStatus, actorId?: string): void {
    const userData = this.getUserData();
    const user = Object.hasOwn(userData.users, userId) ? userData.users[userId] : undefined;

    if (!user) {
      throw Object.assign(new Error("用户不存在"), { status: 404 });
    }

    if (user.role === UserRole.admin && user.status === UserStatus.active && status !== UserStatus.active &&
      !Object.values(userData.users).some(other => other.id !== user.id && other.role === UserRole.admin && other.status === UserStatus.active)) {
      throw Object.assign(new Error("不能停用最后一个可用管理员"), { status: 409 });
    }
    if (user.status === status) return;
    const previousStatus = user.status;
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    user.status = status;
    userData.users[userId] = user;
    this.recordAudit(userData, "statusChanged", user, actorId, previousStatus);
    this.saveUserData(userData);
  }
}

export default new UserManager();
