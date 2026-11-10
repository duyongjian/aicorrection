/**
 * Mock Provider（规则化兜底，INF-04 / ATT-01）
 * 保证无 Ollama 时也能完整演示五步闭环 + 埋点。
 * - 归因：基于学科/关键词启发式返回确定性三项（attr_model_version='mock-v1'）
 * - 追问：返回苏格拉底式补充归因文本
 * - OCR：返回占位题干（ocr_status='partial'，由 ocrService 标记）
 */
import { MOCK_ATTR_MODEL_VERSION } from '@aicorrection/shared';
import type { LlmMessage, LlmOptions, LlmProvider, LlmResult } from './provider';

type Subject = 'math' | 'english' | 'politics' | 'logic' | 'general';

function detectSubject(text: string): Subject {
  const t = text.toLowerCase();
  if (/数学|导数|积分|函数|几何|数列|概率|方程|微积分|向量/.test(text)) return 'math';
  if (/英语|单词|语法|阅读|作文|时态|从句|vocabulary|grammar/.test(text)) return 'english';
  if (/政治|马原|毛中特|马哲|史纲|思修|哲学/.test(text)) return 'politics';
  if (/逻辑|推理|论证|归纳|演绎|削弱|加强/.test(text)) return 'logic';
  if (/(math|derivative|integral|geometry)/.test(t)) return 'math';
  return 'general';
}

export const MOCK_PLACEHOLDER_QUESTION =
  '（示例占位题干）检测到题目区域，但 OCR 内容不完整。请改用文本入口补充题目，或重拍清晰照片以继续五步闭环演示。';

export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  async isAvailable(): Promise<boolean> {
    return false; // Mock 永远"不可达真实模型"，仅作兜底
  }

  async listModels(): Promise<string[]> {
    return []; // Mock 无真实模型端点
  }

  async chat(
    messages: LlmMessage[],
    opts?: LlmOptions
  ): Promise<LlmResult> {
    const system =
      messages.find((m) => m.role === 'system')?.content ?? '';
    const user =
      [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // 追问模式：system 含 [FOLLOWUP_MODE] 哨兵
    if (system.includes('[FOLLOWUP_MODE]')) {
      return {
        text: this.mockFollowup(user),
        model: MOCK_ATTR_MODEL_VERSION,
        latencyMs: 20,
      };
    }
    // 讲解模式（无作答）：system 含"未提供自己的作答"哨兵（ATTR_SYSTEM_NOANSWER）。
    // 该模式下必须产出 正确答案/正确推导/常见陷阱/知识点/本质 五段，否则 parseTeaching 取不到 hasCore。
    const isTeach = system.includes('未提供自己的作答') || system.includes('规范讲解');
    if (isTeach) {
      return {
        text: this.mockTeaching(user),
        model: MOCK_ATTR_MODEL_VERSION,
        latencyMs: 30,
      };
    }
    return {
      text: this.mockAttribution(user),
      model: MOCK_ATTR_MODEL_VERSION,
      latencyMs: 30,
    };
  }

  async chatWithImage(
    _imageBase64: string,
    _prompt: string,
    _opts?: LlmOptions
  ): Promise<LlmResult> {
    // Mock 视觉模型：返回占位题干，由 ocrService 标记为 partial
    return {
      text: MOCK_PLACEHOLDER_QUESTION,
      model: MOCK_ATTR_MODEL_VERSION,
      latencyMs: 25,
    };
  }

  private mockAttribution(question: string): string {
    const subject = detectSubject(question);
    const kp = this.knowledgePoint(subject, question);
    const cause = this.cause(subject, question);
    const essence = this.essence(subject, question);
    return `错因：${cause}\n知识点：${kp}\n本质：${essence}`;
  }

  /**
   * 讲解模式（无作答）兜底输出：产出 正确答案 / 正确推导 / 常见陷阱 / 知识点 / 本质 五段，
   * 与 ATTR_SYSTEM_NOANSWER 契约对齐，确保 parseTeaching 取到 hasCore（否则讲解模式无解）。
   * 数学导数类给出与 smoke 示例一致的具体结论；其余学科给出结构化讲解框架。
   */
  private mockTeaching(question: string): string {
    const subject = detectSubject(question);
    const kp = this.knowledgePoint(subject, question);
    const essence = this.essence(subject, question);
    const correct = this.teachCorrectAnswer(subject, question);
    const derivation = this.teachDerivation(subject, question);
    const pitfall = this.teachPitfall(subject, question);
    return `正确答案：${correct}\n正确推导：\n${derivation}\n常见陷阱：${pitfall}\n知识点：${kp}\n本质：${essence}`;
  }

  private teachCorrectAnswer(subject: Subject, q: string): string {
    switch (subject) {
      case 'math':
        if (/导数|单调|极值/.test(q)) {
          return '$f\'(x)=3x^2-3=3(x-1)(x+1)$，驻点 $x=\\pm1$；在 $[-2,2]$ 上于 $(-\\infty,-1]$、$[1,+\\infty)$ 单调递增，于 $[-1,1]$ 单调递减，极大值 $f(-1)=2$、极小值 $f(1)=-2$。';
        }
        if (/积分/.test(q)) return '按定积分定义与换元法逐步计算，注意积分上下限随换元同步变换后求值。';
        if (/数列/.test(q)) return '先求通项或前 $n$ 项和的闭式，再据闭式判断收敛性或求和。';
        return '按该题型的规范步骤求解，给出在给定条件下的结论。';
      case 'english':
        return '结合语境还原作者真实逻辑，选择/写出符合语法与语义的答案。';
      case 'politics':
        return '用矛盾分析法穿透现象，给出符合原理的结论。';
      case 'logic':
        return '先锁定论证结构，再判断削弱/加强的作用点。';
      default:
        return '在给定条件下，按题干约束给出正确结论。';
    }
  }

  private teachDerivation(subject: Subject, q: string): string {
    switch (subject) {
      case 'math':
        if (/导数|单调|极值/.test(q)) {
          return (
            '$$f\'(x)=3x^2-3=3(x-1)(x+1)$$\n' +
            '$$f\'(x)>0 \\Rightarrow x<-1 \\text{ 或 } x>1;\\quad f\'(x)<0 \\Rightarrow -1<x<1$$\n' +
            '$$f(-1)=2,\\ f(1)=-2,\\ f(\\pm2)=\\pm2$$'
          );
        }
        if (/积分/.test(q)) return '$$\\int_a^b f(x)\\,dx = F(b)-F(a)$$\n$$令\\,u=g(x)\\,换元，上下限同步:\\,\\int_{g(a)}^{g(b)}\\cdots\\,du$$';
        if (/数列/.test(q)) return '$$a_n = \\cdots \\quad (n\\ge 1)$$\n$$S_n = \\sum_{k=1}^n a_k = \\cdots$$';
        return '$$依题干条件逐步推导$$\n$$化简得到结论$$';
      case 'english':
        return '$$锁定主谓宾与修饰关系$$\n$$依据时态/从句规则还原语义$$';
      case 'politics':
        return '$$定位矛盾双方$$\n$$用对立统一规律分析本质$$';
      case 'logic':
        return '$$拆解前提与结论$$\n$$定位论证结构后再判断$$';
      default:
        return '$$按题干条件逐步推导$$\n$$得出在给定条件下的结论$$';
    }
  }

  private teachPitfall(subject: Subject, q: string): string {
    switch (subject) {
      case 'math':
        if (/导数|单调|极值/.test(q)) {
          return '漏掉端点 $x=\\pm2$ 的函数值比较而错判全局最值；把驻点直接当极值点却未验证导数符号变化；因式分解或代入计算符号出错。';
        }
        return '混淆公式适用前提；计算符号/步骤出错；忽略定义域或端点约束。';
      case 'english':
        return '孤立记忆语法条条而忽略语境；时态与上下文不一致。';
      case 'politics':
        return '背诵结论却不穿透现象；混淆哲学范畴边界。';
      case 'logic':
        return '未先锁定论证结构就下判断；削弱/加强作用点找错。';
      default:
        return '未先明确知识适用前提就机械套用方法。';
    }
  }

  private mockFollowup(question: string): string {
    const subject = detectSubject(question);
    return (
      `补充归因（苏格拉底式）：你追问的这一点，恰好触及"为什么错"的更深一层——` +
      `建议从「定义与适用前提」出发再拆解一步，而不是停留在计算或套用表面。` +
      `试着用自己的话复述「${this.knowledgePoint(subject, question)}」的适用条件，` +
      `若说不清，说明该知识点尚未真正内化（v0.2 将开放验证环节）。`
    );
  }

  private knowledgePoint(subject: Subject, q: string): string {
    switch (subject) {
      case 'math':
        if (/导数/.test(q)) return '导数与单调性判别';
        if (/积分/.test(q)) return '定积分的几何意义与换元';
        if (/数列/.test(q)) return '数列求和与通项';
        if (/概率/.test(q)) return '条件概率与独立性';
        return '核心概念与公式适用条件';
      case 'english':
        if (/时态/.test(q)) return '时态一致与语境判断';
        if (/从句/.test(q)) return '从句引导词辨析';
        return '句法与上下文逻辑';
      case 'politics':
        return '哲学范畴与矛盾分析法';
      case 'logic':
        return '论证结构与削弱方式';
      default:
        return '题干所对应的核心知识点';
    }
  }

  private cause(subject: Subject, q: string): string {
    if (/算错|计算|粗心/.test(q)) return '计算过程中符号或步骤出错，而非概念不清';
    if (/概念|混淆|搞混/.test(q)) return '对相邻概念的边界区分不清，发生张冠李戴';
    if (/审题|没看|漏看/.test(q)) return '审题不充分，遗漏关键约束条件';
    if (/方法|不会|没思路/.test(q)) return '未识别题型对应的标准解法路径';
    return '对知识本质的理解停留在表面，未抓住适用前提';
  }

  private essence(subject: Subject, q: string): string {
    switch (subject) {
      case 'math':
        return '数学题的本质是「在正确前提下选择并正确执行推理规则」，错因常源于前提误用而非运算本身。';
      case 'english':
        return '英语题的本质是「在语境中还原作者真实逻辑」，而非孤立记忆语法条条。';
      case 'politics':
        return '政治题的本质是「用矛盾分析法穿透现象看本质」，而非背诵结论。';
      case 'logic':
        return '逻辑题的本质是「先锁定论证结构，再判断削弱/加强的作用点」。';
      default:
        return '这道题的本质是「先明确知识适用前提，再决定方法」，而非机械套用。';
    }
  }
}
