#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDE 数学内核 · 参考实现（Oracle）
===================================
角色：本文件是 TypeScript 内核（packages/pde-kernel）的唯一权威规范。
     Claude Code 移植 TS 后，必须逐数值通过本文件生成的 golden-tests.json（容差 1e-6）。
规则：
  1. 纯函数、确定性、无 I/O 依赖（生成 golden 除外）；LLM 永远不在计算路径上。
  2. 任何公式/参数改动：先改本文件 → 重新生成 golden → 再改 TS。禁止直接改 golden 期望值。
  3. 参数与 seeds/params.json 保持一致（本文件为准，params.json 是其导出）。
决策基线（2026-07-01，LG 拍板）：
  - w_i 完全沿用 G64111 分值先验（A=20 D=20 采购4/2/4 关键影响人=10 组员各1池5）
  - 可信度四档 c: 1.0/0.8/0.45/0.15；半衰期 30/90/180 天
  - CHECK 触发已从"熵>0.85"改为"关键干系人 n_eff<3.0"（数值验证后的重标定，见 SPEC §K5）
"""
import json, math, copy

# ── 参数（与 seeds/params.json 同步） ────────────────────────────────
MARK_TARGET = {          # 倾向标记 → 立场目标分布 (pS, pN, pO)
    "star":  (0.85, 0.10, 0.05),
    "plus":  (0.65, 0.25, 0.10),
    "eq":    (0.20, 0.60, 0.20),
    "unk":   (1/3,  1/3,  1/3),
    "minus": (0.10, 0.25, 0.65),
    "x":     (0.05, 0.10, 0.85),
}
CRED = {                 # 可信度四档：c=可信度系数（加权分用），n=等效样本量（分布锐度用）
    "consensus": {"c": 1.00, "n": 8.0},   # 共识
    "explicit":  {"c": 0.80, "n": 5.0},   # 明确
    "inference": {"c": 0.45, "n": 2.5},   # 推理
    "unclear":   {"c": 0.15, "n": 1.0},   # 不清
}
N0 = 2.0                 # 均匀先验强度（贝叶斯收缩：低可信度→向中性回归）
LAMBDA = 1.3             # 反对杀伤系数（国企一票否决现象）
K, S_MID = 4.0, 0.15     # logistic 标定：pWin_raw = σ(K·(S−S_MID))
GATE_PO, GATE_CAP = 0.60, 0.15   # 否决门：A 的 pO≥0.60 → pWin 封顶 0.15
M_STAGE = {              # C4 阶段 → 可塑性乘子 m（乘在行动 ΔpWin 上）
    "initiation": 1.00, "feasibility": 0.85, "budget_approval": 0.65,
    "tender_design": 0.40, "tender_execution": 0.20,
}
C4_LEGACY = {"initiation": 5, "feasibility": 4, "budget_approval": 3,
             "tender_design": 2, "tender_execution": 1}
HALFLIFE = {"procurement": 30.0, "stance": 90.0, "structural": 180.0}
SLOT_W = {"A": 20.0, "D": 20.0, "PROC_MGMT": 4.0, "PROC_AGENT": 2.0,
          "OWNER_REP": 4.0, "KEY_INFLUENCER": 10.0, "MEMBER": 1.0}
MEMBER_POOL_CAP = 5.0    # P1 组员权重池上限
CHECK_NEFF = 3.0         # CHECK 触发：关键干系人 n_eff < 3.0
CHECK_W_NORM = 0.15      # "关键干系人" = 归一化权重 ≥ 0.15
CHECK_SCORE_GAP = 20.0   # CHECK 触发：名义分 − 加权分 > 20
RAISE_RATIO = 1.5        # RAISE 触发：ΔpWin·pot·m / cost ≥ 1.5
RAISE_MIN_M = 0.40       # RAISE 需要阶段窗口未关闭

# ── 内核函数 ────────────────────────────────────────────────────────
def decay(age_days: float, half_life: float) -> float:
    return 0.5 ** (age_days / half_life)

def blend(mark, cred="unclear", q=1.0, age_days=0.0, half_life=HALFLIFE["stance"]):
    """(标记, 可信度, 信源质量, 信息年龄) → (混合后立场分布 p, 有效样本量 n_eff)"""
    n = (CRED["unclear"]["n"] if mark == "unk" else CRED[cred]["n"]) * q * decay(age_days, half_life)
    t = MARK_TARGET[mark]
    a = [n * t[i] + N0 / 3.0 for i in range(3)]
    s = sum(a)
    return tuple(x / s for x in a), n

def entropy3(p):
    """归一化熵 ∈[0,1]，仅用于展示，不参与决策触发"""
    return -sum(x * math.log(x) for x in p if x > 0) / math.log(3)

def stakeholder_weight(st):
    return sum(SLOT_W[s] for s in st["slots"])

def evaluate(deal):
    """牌局评估：S、pWin、gate、EV、逐干系人明细"""
    members = [s for s in deal["stakeholders"] if s["slots"] == ["MEMBER"]]
    member_w = MEMBER_POOL_CAP / len(members) if len(members) > MEMBER_POOL_CAP else 1.0
    num = den = 0.0
    gate = False
    detail = []
    for st in deal["stakeholders"]:
        w = member_w if st["slots"] == ["MEMBER"] else stakeholder_weight(st)
        p, n_eff = blend(st["mark"], st.get("cred", "unclear"), st.get("q", 1.0), st.get("age_days", 0.0))
        net = p[0] - LAMBDA * p[2]
        num += w * net
        den += w
        if "A" in st["slots"] and p[2] >= GATE_PO:
            gate = True
        detail.append({"id": st["id"], "w": w, "pS": p[0], "pN": p[1], "pO": p[2],
                       "net": net, "n_eff": n_eff, "entropy": entropy3(p)})
    for d in detail:
        d["w_norm"] = d["w"] / den
    S = num / den
    pwin_raw = 1.0 / (1.0 + math.exp(-K * (S - S_MID)))
    pwin = pwin_raw * deal.get("c_comp", 1.0)
    if gate:
        pwin = min(pwin, GATE_CAP)
    m = M_STAGE[deal["stage"]]
    ev = pwin * deal["pot"] - deal["planned_cost"]
    return {"S": S, "pwin_raw": pwin_raw, "pwin": pwin, "gate": gate,
            "m_stage": m, "ev_continue": ev, "stakeholders": detail}

def weighted_score(items):
    """名义分 / 加权分：items = [{key, raw, cred, q?, age_days?, volatility?}]"""
    nominal = weighted = 0.0
    for it in items:
        hl = HALFLIFE[it.get("volatility", "stance")]
        c_eff = CRED[it["cred"]]["c"] * it.get("q", 1.0) * decay(it.get("age_days", 0.0), hl)
        nominal += it["raw"]
        weighted += it["raw"] * c_eff
    return {"nominal": nominal, "weighted": weighted, "gap": nominal - weighted}

def apply_effect(deal, stakeholder_id, new_mark=None, new_cred=None):
    d = copy.deepcopy(deal)
    for st in d["stakeholders"]:
        if st["id"] == stakeholder_id:
            if new_mark: st["mark"] = new_mark
            if new_cred: st["cred"] = new_cred
            st["age_days"] = 0.0
    return d

def action_delta_ev(deal, action):
    """行动 ΔEV：effect = {stakeholder_id, new_mark?, new_cred?}；info 类动作即 cred 升级"""
    base = evaluate(deal)
    after = evaluate(apply_effect(deal, action["stakeholder_id"],
                                  action.get("new_mark"), action.get("new_cred")))
    d_pwin = after["pwin"] - base["pwin"]
    gross = d_pwin * deal["pot"] * base["m_stage"]
    dev = gross - action["cost"]
    return {"action_id": action["id"], "d_pwin": d_pwin, "gross": gross,
            "cost": action["cost"], "dEV": dev,
            "ratio": (gross / action["cost"]) if action["cost"] > 0 else float("inf")}

def voi_stance(deal, stakeholder_id, opt=("plus", "explicit"), pess=("minus", "explicit")):
    """立场类未知项的信息价值：乐观/悲观合理值扫描"""
    p_opt = evaluate(apply_effect(deal, stakeholder_id, *opt))["pwin"]
    p_pes = evaluate(apply_effect(deal, stakeholder_id, *pess))["pwin"]
    m = M_STAGE[deal["stage"]]
    return {"stakeholder_id": stakeholder_id, "pwin_opt": p_opt, "pwin_pess": p_pes,
            "voi": (p_opt - p_pes) * deal["pot"] * m}

def voi_ccomp(deal, lo=0.70, hi=1.00):
    """C5 招采未知 → 竞争系数扫描"""
    d1, d2 = copy.deepcopy(deal), copy.deepcopy(deal)
    d1["c_comp"], d2["c_comp"] = hi, lo
    m = M_STAGE[deal["stage"]]
    return {"var": "c_comp", "voi": (evaluate(d1)["pwin"] - evaluate(d2)["pwin"]) * deal["pot"] * m}

def recommend(ev_now, actions_dev, stakeholders_detail, score, m_stage, prev_ev=None):
    """四动作纪律。优先级：FOLD > CHECK > RAISE > CALL"""
    has_positive = any(a["dEV"] > 0 for a in actions_dev)
    if ev_now["ev_continue"] < 0 and prev_ev is not None and prev_ev < 0 and not has_positive:
        return {"action": "FOLD", "reason": "EV 连续两期为负且无正 ΔEV 动作"}
    weak_key = [d["id"] for d in stakeholders_detail
                if d["w_norm"] >= CHECK_W_NORM and d["n_eff"] < CHECK_NEFF]
    if weak_key or score["gap"] > CHECK_SCORE_GAP:
        return {"action": "CHECK", "reason": "关键干系人低可信度或名义/加权分差过大",
                "weak_key_stakeholders": weak_key, "score_gap": score["gap"]}
    raisable = [a for a in actions_dev if a["dEV"] > 0 and a["ratio"] >= RAISE_RATIO]
    if raisable and m_stage >= RAISE_MIN_M:
        best = max(raisable, key=lambda a: a["dEV"])
        return {"action": "RAISE", "reason": "存在高杠杆动作且阶段窗口未关闭",
                "best_action": best["action_id"]}
    return {"action": "CALL", "reason": "EV 为正，维持节奏" if ev_now["ev_continue"] > 0
            else "EV 为负但存在正 ΔEV 动作或未满两期，观察一期"}

# ── 黄金测试夹具（数字能源场景，pot 单位：万元） ─────────────────────
def fixtures():
    A_deal = {  # 单A：铁证支撑的 60 分单（对应设计文档 §4.6，数值以本实现为准）
        "id": "golden-deal-A", "pot": 100.0, "planned_cost": 8.0,
        "stage": "budget_approval", "c_comp": 0.85,
        "stakeholders": [
            {"id": "A",    "slots": ["A"],              "mark": "plus", "cred": "consensus"},
            {"id": "D",    "slots": ["D"],              "mark": "plus", "cred": "explicit"},
            {"id": "PM",   "slots": ["PROC_MGMT"],      "mark": "eq",   "cred": "explicit"},
            {"id": "AG",   "slots": ["PROC_AGENT"],     "mark": "unk"},
            {"id": "OR",   "slots": ["OWNER_REP"],      "mark": "plus", "cred": "inference"},
            {"id": "KI",   "slots": ["KEY_INFLUENCER"], "mark": "plus", "cred": "explicit"},
            {"id": "M1",   "slots": ["MEMBER"],         "mark": "eq",   "cred": "inference"},
            {"id": "M2",   "slots": ["MEMBER"],         "mark": "eq",   "cred": "inference"},
        ],
        "items": [
            {"key": "C1", "raw": 8,  "cred": "explicit"},
            {"key": "C2", "raw": 5,  "cred": "explicit"},
            {"key": "C3", "raw": 4,  "cred": "explicit"},
            {"key": "C4", "raw": 3,  "cred": "consensus", "volatility": "structural"},
            {"key": "C5", "raw": 5,  "cred": "explicit",  "volatility": "procurement"},
            {"key": "C6", "raw": 3,  "cred": "explicit"},
            {"key": "P1", "raw": 2,  "cred": "explicit"},
            {"key": "P2", "raw": 5,  "cred": "explicit"},
            {"key": "P3", "raw": 10, "cred": "explicit"},
            {"key": "P4", "raw": 5,  "cred": "explicit"},
            {"key": "1K", "raw": 10, "cred": "consensus"},
        ],
    }
    B_deal = copy.deepcopy(A_deal)  # 单B：同为名义 60 分，但可信度全面塌陷
    B_deal["id"] = "golden-deal-B"
    for st, (mk, cr) in zip(B_deal["stakeholders"], [
        ("plus", "unclear"), ("plus", "inference"), ("unk", None), ("unk", None),
        ("unk", None), ("plus", "unclear"), ("unk", None), ("unk", None)]):
        st["mark"] = mk
        if cr: st["cred"] = cr
        elif "cred" in st: del st["cred"]
    for it, cr in zip(B_deal["items"],
        ["inference", "unclear", "inference", "consensus", "unclear", "inference",
         "inference", "unclear", "inference", "unclear", "unclear"]):
        it["cred"] = cr
    G_deal = copy.deepcopy(A_deal)  # 单G：A 明确支持对手 → 否决门
    G_deal["id"] = "golden-deal-Gate"
    G_deal["stakeholders"][0].update({"mark": "x", "cred": "explicit"})
    F_deal = {  # 单F：小池 + 全面劣势 + 连续两期负 EV → FOLD
        "id": "golden-deal-Fold", "pot": 10.0, "planned_cost": 8.0,
        "stage": "budget_approval", "c_comp": 0.85,
        "stakeholders": [
            {"id": "A",  "slots": ["A"],              "mark": "minus", "cred": "explicit"},
            {"id": "D",  "slots": ["D"],              "mark": "eq",    "cred": "inference"},
            {"id": "PM", "slots": ["PROC_MGMT"],      "mark": "unk"},
            {"id": "AG", "slots": ["PROC_AGENT"],     "mark": "unk"},
            {"id": "OR", "slots": ["OWNER_REP"],      "mark": "unk"},
            {"id": "KI", "slots": ["KEY_INFLUENCER"], "mark": "unk"},
            {"id": "M1", "slots": ["MEMBER"],         "mark": "unk"},
            {"id": "M2", "slots": ["MEMBER"],         "mark": "unk"},
        ],
        "items": [{"key": "C1", "raw": 5, "cred": "inference"}],
    }
    ACTIONS = {  # 测试用动作（对应 seeds/action-library.json 的三种效果类型）
        "A": [
            {"id": "act-1k-exec-visit", "stakeholder_id": "A", "new_mark": "star", "cost": 1.5},
            {"id": "act-p3-coplan",     "stakeholder_id": "D", "new_mark": "star", "new_cred": "explicit", "cost": 1.0},
        ],
        "B": [
            {"id": "act-verify-D",      "stakeholder_id": "D", "new_cred": "explicit", "cost": 0.3},   # 信息动作＝可信度升级
            {"id": "act-1k-exec-visit", "stakeholder_id": "A", "new_mark": "star", "new_cred": "explicit", "cost": 1.5},
        ],
        "G": [
            {"id": "act-flip-A",        "stakeholder_id": "A", "new_mark": "eq", "new_cred": "inference", "cost": 2.0},
        ],
        "F": [
            {"id": "act-fix-A",         "stakeholder_id": "A", "new_mark": "plus", "new_cred": "explicit", "cost": 1.5},
            {"id": "act-fix-D",         "stakeholder_id": "D", "new_mark": "plus", "new_cred": "explicit", "cost": 1.0},
        ],
    }
    return A_deal, B_deal, G_deal, F_deal, ACTIONS

def run_case(deal, actions, prev_ev=None):
    ev = evaluate(deal)
    score = weighted_score(deal["items"])
    devs = [action_delta_ev(deal, a) for a in actions]
    rec = recommend(ev, devs, ev["stakeholders"], score, ev["m_stage"], prev_ev)
    return {"input": deal, "eval": ev, "score": score, "actions": devs, "recommendation": rec}

def main():
    A, B, G, F, ACT = fixtures()
    golden = {"params_echo": {
        "MARK_TARGET": MARK_TARGET, "CRED": CRED, "N0": N0, "LAMBDA": LAMBDA,
        "K": K, "S_MID": S_MID, "GATE_PO": GATE_PO, "GATE_CAP": GATE_CAP,
        "M_STAGE": M_STAGE, "HALFLIFE": HALFLIFE, "SLOT_W": SLOT_W,
        "MEMBER_POOL_CAP": MEMBER_POOL_CAP, "CHECK_NEFF": CHECK_NEFF,
        "CHECK_W_NORM": CHECK_W_NORM, "CHECK_SCORE_GAP": CHECK_SCORE_GAP,
        "RAISE_RATIO": RAISE_RATIO, "RAISE_MIN_M": RAISE_MIN_M},
        "cases": {}}
    golden["cases"]["deal_A_raise"] = run_case(A, ACT["A"])
    golden["cases"]["deal_B_check"] = run_case(B, ACT["B"])
    golden["cases"]["deal_B_voi_A"] = voi_stance(B, "A")
    golden["cases"]["deal_B_voi_ccomp"] = voi_ccomp(B)
    golden["cases"]["deal_Gate"] = run_case(G, ACT["G"])
    golden["cases"]["deal_Fold"] = run_case(F, ACT["F"], prev_ev=-5.0)

    def rnd(o):
        if isinstance(o, float): return round(o, 6)
        if isinstance(o, dict): return {k: rnd(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)): return [rnd(x) for x in o]
        return o
    golden = rnd(golden)
    out = __file__.rsplit("/", 1)[0] + "/golden-tests.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(golden, f, ensure_ascii=False, indent=2)
    # 控制台摘要
    for name in ["deal_A_raise", "deal_B_check", "deal_Gate", "deal_Fold"]:
        c = golden["cases"][name]
        print(f"[{name}] S={c['eval']['S']:.4f} pWin={c['eval']['pwin']:.4f} "
              f"gate={c['eval']['gate']} EV={c['eval']['ev_continue']:.2f} "
              f"nominal={c['score']['nominal']:.0f} weighted={c['score']['weighted']:.2f} "
              f"→ {c['recommendation']['action']}")
        for a in c["actions"]:
            print(f"    {a['action_id']}: ΔpWin={a['d_pwin']:+.4f} ΔEV={a['dEV']:+.3f} ratio={a['ratio']:.2f}")
    v = golden["cases"]["deal_B_voi_A"]
    print(f"[deal_B_voi_A] pWin_opt={v['pwin_opt']:.4f} pWin_pess={v['pwin_pess']:.4f} VoI={v['voi']:.2f} 万")
    print(f"[deal_B_voi_ccomp] VoI={golden['cases']['deal_B_voi_ccomp']['voi']:.2f} 万")
    print(f"\ngolden-tests.json written → {out}")

if __name__ == "__main__":
    main()
