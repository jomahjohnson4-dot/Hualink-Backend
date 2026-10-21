import prisma from '../utils/prismaClient.js';

/** The four languages the platform ships FAQ content in. */
export const SUPPORTED_LANGUAGES = ['en', 'sw', 'zh', 'fr'];

/**
 * Coerces the stored JSON blob into a complete `{ en, sw, zh, fr }` map so the
 * frontend never has to guard against missing keys.
 */
export const normaliseAnswers = (raw) => {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return SUPPORTED_LANGUAGES.reduce((acc, lang) => {
    const value = source[lang];
    acc[lang] = typeof value === 'string' ? value : '';
    return acc;
  }, {});
};

/**
 * GET /api/faqs
 * Public FAQ list. Pass `?lang=en` to also receive a flattened `answer` field
 * for that single language (used by the public-facing FAQ accordion).
 */
export const getFaqs = async (req, res, next) => {
  try {
    const { lang } = req.query;

    if (lang && !SUPPORTED_LANGUAGES.includes(String(lang).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: `Unsupported language. Expected one of: ${SUPPORTED_LANGUAGES.join(', ')}.`,
      });
    }

    const faqs = await prisma.faq.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const data = faqs.map((faq) => {
      const answers = normaliseAnswers(faq.answers);
      return {
        id: faq.id,
        question: faq.question,
        answers,
        ...(lang ? { answer: answers[String(lang).toLowerCase()] } : {}),
        sortOrder: faq.sortOrder,
        createdAt: faq.createdAt,
        updatedAt: faq.updatedAt,
      };
    });

    res.status(200).json({ success: true, data, languages: SUPPORTED_LANGUAGES });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/faqs/:id
 */
export const getFaqById = async (req, res, next) => {
  try {
    const faq = await prisma.faq.findUnique({ where: { id: req.params.id } });

    if (!faq) {
      return res.status(404).json({ success: false, message: 'FAQ not found.' });
    }

    res.status(200).json({
      success: true,
      data: { ...faq, answers: normaliseAnswers(faq.answers) },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/faqs
 * Creates a multilingual FAQ entry.
 */
export const createFaq = async (req, res, next) => {
  try {
    const { question, answers, sortOrder } = req.body || {};

    if (!question || !String(question).trim()) {
      return res.status(400).json({
        success: false,
        message: 'A FAQ question is required.',
      });
    }

    const normalisedAnswers = normaliseAnswers(answers);
    const hasTranslation = SUPPORTED_LANGUAGES.some((lang) => normalisedAnswers[lang].trim());

    if (!hasTranslation) {
      return res.status(400).json({
        success: false,
        message: `At least one translated answer is required (${SUPPORTED_LANGUAGES.join(', ')}).`,
      });
    }

    const faq = await prisma.faq.create({
      data: {
        question: String(question).trim(),
        answers: normalisedAnswers,
        ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) || 0 } : {}),
      },
    });

    res.status(201).json({
      success: true,
      message: 'FAQ created successfully.',
      data: { ...faq, answers: normalisedAnswers },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/faqs/:id
 * Updates the question and/or any of the four translations.
 */
export const updateFaq = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { question, answers, sortOrder, isActive } = req.body || {};

    const existing = await prisma.faq.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'FAQ not found.' });
    }

    const data = {};
    if (question !== undefined) {
      if (!String(question).trim()) {
        return res.status(400).json({ success: false, message: 'Question cannot be empty.' });
      }
      data.question = String(question).trim();
    }
    if (answers !== undefined) {
      // Merge with the stored translations so a partial update never wipes a
      // language. Only the keys the caller actually supplied are applied.
      const merged = { ...normaliseAnswers(existing.answers) };
      if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
        SUPPORTED_LANGUAGES.forEach((lang) => {
          if (typeof answers[lang] === 'string') merged[lang] = answers[lang];
        });
      }
      data.answers = merged;
    }
    if (sortOrder !== undefined) data.sortOrder = Number(sortOrder) || 0;
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    const faq = await prisma.faq.update({ where: { id }, data });

    res.status(200).json({
      success: true,
      message: 'FAQ updated successfully.',
      data: { ...faq, answers: normaliseAnswers(faq.answers) },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/faqs/:id
 */
export const deleteFaq = async (req, res, next) => {
  try {
    await prisma.faq.delete({ where: { id: req.params.id } });
    res.status(200).json({ success: true, message: 'FAQ deleted successfully.' });
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'FAQ not found.' });
    }
    next(error);
  }
};
