import { Request, Response } from 'express';
import { errorResponse } from '../utils/error';
import { prisma } from '@repo/db';
import { generateCode } from '../utils/code';

const DIFFICULTIES = ['Low', 'Medium', 'High'];

export const createQuizController = async (req: Request, res: Response) => {
    try {

        const { title, description } = req.body;

        if (!title || !description) return errorResponse(res, 400, "Title and description are required");

        const quiz = await prisma.quiz.create({
            data: {
                title,
                description,
                creatorId: req.userId,
                quizOrganizers: {
                    create: {
                        userId: req.userId,
                        role: 'OWNER',
                        inviteStatus: 'ACCEPTED'
                    }
                }
            }
        })

        return res.status(201).json(quiz);

    } catch (error) {
        console.log("Quiz creation errror: ", error);
        return errorResponse(res, 500, "Internal Srever Erorr")
    }
}



export const getAllQuizesController = async (req: Request, res: Response) => {
    try {

        const organizedQuizes = await prisma.quiz.findMany({
            where: {
                quizOrganizers: {
                    some: {
                        userId: req.userId,
                        inviteStatus: 'ACCEPTED'
                    }
                }
            },
            include: {
                _count: { select: { questions: true, quizSessions: true } }
            },
            orderBy: { createdAt: 'desc' }
        });


        const participatedQuizes = await prisma.quizSession.findMany({
            where: {
                participants: {
                    some: {
                        userId: req.userId,
                    }
                }
            },
            include: {
                quiz: true,
                participants: {
                    where: {
                        userId: req.userId
                    }
                },
                // Total players in the session, so a past quiz can say
                // "12th of 300" rather than just a score with no context.
                _count: { select: { participants: true } }
            },
            orderBy: { createdAt: 'desc' }

        });

        // Rank is a position within a session, which SQL will not give us from
        // the query above. Counting how many beat each player is one query for
        // the whole dashboard rather than one per quiz.
        const myParticipantIds = participatedQuizes
            .map((s) => s.participants[0]?.id)
            .filter((id): id is string => Boolean(id));

        const ranks = new Map<string, number>();
        if (myParticipantIds.length > 0) {
            const rows = await prisma.$queryRaw<{ id: string; rank: number }[]>`
                SELECT me.id,
                       (
                         SELECT count(*) + 1
                         FROM "Participant" other
                         WHERE other."sessionId" = me."sessionId"
                           AND other.score > me.score
                       )::int AS rank
                FROM "Participant" me
                WHERE me.id = ANY(${myParticipantIds})
            `;
            for (const row of rows) ranks.set(row.id, row.rank);
        }

        const participatedWithRank = participatedQuizes.map((session) => ({
            ...session,
            totalParticipants: session._count.participants,
            myRank: ranks.get(session.participants[0]?.id ?? '') ?? null,
        }));


        return res.status(200).json({
            organizedQuizes,
            participated: participatedWithRank
        })

    } catch (error) {
        console.log("Get all quizes error: ", error);
        return errorResponse(res, 500, "Internal Srever Erorr")
    }
}




// getting quiz by id
export const getQuizByIdController = async (req: Request, res: Response) => {
    try {
        const { quizId } = req.params;


        const quiz = await prisma.quiz.findUnique({
            where: {
                id: quizId as string,
                quizOrganizers: {
                    some: {
                        userId: req.userId,
                        inviteStatus: 'ACCEPTED'
                    }
                }
            },
            include: {
                questions: {
                    include: { answers: true },
                    orderBy: { order: 'asc' }
                },
                quizOrganizers: {
                    include: {
                        user: {
                            select: { name: true, email: true }
                        }
                    }
                }
            },

        })


        if (!quiz) return errorResponse(res, 404, "Quiz not found or you don't have access to it");

        return res.status(200).json(quiz);
    } catch (error) {
        console.log("Get quiz by id error: ", error);
        return errorResponse(res, 500, "Internal Srever Erorr")

    }
}





// to generate the access-code for a quiz session to join 
export const generateAccessCodeController = async (req: Request, res: Response) => {
    try {

        const { quizId } = req.params;

        const isOrganizer = await prisma.quizOrganizer.findFirst({
            where: {
                quizId: quizId as string,
                userId: req.userId,
                inviteStatus: 'ACCEPTED'
            }
        })

        if (!isOrganizer) return errorResponse(res, 403, "You don't have access to this quiz")

        for (let i = 0; i < 5; i++) {
            const code = generateCode();

            const isCodeExisted = await prisma.quiz.findUnique({
                where: {
                    joinCode: code
                }
            })

            if (!isCodeExisted) {
                const quiz = await prisma.quiz.update({
                    where: {
                        id: quizId as string
                    },
                    data: {
                        joinCode: code, status: 'ACTIVE'
                    }
                });
                return res.status(200).json({ joinCode: quiz.joinCode });
            }
        }

        return errorResponse(res, 500, "Couldn't generate a unique access code, please try again")

    } catch (error) {

        console.log("Generate access code error: ", error);
        return errorResponse(res, 500, "Internal Srever Erorr")

    }
}



// creating question for a quiz
export const createQuestionController = async (req: Request, res: Response) => {
    try {
        const { quizId } = req.params;
        const { text, timeLimit, answers, difficulty = "Medium" } = req.body;

        if (!text || !timeLimit || !answers) return errorResponse(res, 400, "Text, time limit and answers are required")

        if (!DIFFICULTIES.includes(difficulty)) return errorResponse(res, 400, "Difficulty must be Low, Medium or High")

        const isOrganizer = await prisma.quizOrganizer.findFirst({
            where: {
                quizId: quizId as string,
                userId: req.userId,
                inviteStatus: 'ACCEPTED'
            }
        })

        if (!isOrganizer) return errorResponse(res, 403, "You don't have access to this quiz");

        const totalQuestions = await prisma.question.count({
            where: {
                quizId: quizId as string
            }
        });


        const question = await prisma.question.create({
            data: {
                text,
                timeLimit: timeLimit || 15,
                order: totalQuestions + 1,
                difficulty,
                quizId: quizId as string,
                answers: {
                    create: answers.map((answer: any) => ({
                        text: answer.text,
                        isCorrect: answer.isCorrect
                    }))
                }
            },
            include: {
                answers: true
            }
        });

        return res.status(201).json(question);

    } catch (error) {
        console.log("Create question error: ", error);
        return errorResponse(res, 500, "Internal Server Error")
    }
}







export const startQuizSessionController = async (req: Request, res: Response) => {
    try {
        const quizId = req.params.quizId;

        const isOrganozer = await prisma.quizOrganizer.findFirst({
            where: {
                quizId: quizId as string,
                userId: req.userId,
                inviteStatus: 'ACCEPTED'
            }
        });

        if (!isOrganozer) return errorResponse(res, 403, "You don't have access to this quiz");

        const quiz = await prisma.quiz.findUnique({
            where: { id: quizId as string },
            include: {
                quizSessions: {
                    where: { status: 'WAITING' },
                    orderBy: { createdAt: 'desc' },
                    take: 1
                }
            }
        });

        if (!quiz) return errorResponse(res, 404, "Quiz not found");

        if (quiz.status !== 'ACTIVE') return errorResponse(res, 400, "Quiz is not active. Please generate access code first");

        const liveVideo = req.body?.liveVideo === true;

        let session: typeof quiz.quizSessions[number] | undefined = quiz.quizSessions[0];

        // The lobby already open was set up for the other mode. Players who
        // joined it were told whether there is video, and a live video lobby
        // may hold more than an ordinary one allows, so it cannot be switched
        // under them. An empty lobby is replaced instead of updated: ws-server
        // caches the session row, and a fresh id cannot be served stale.
        if (session && session.liveVideo !== liveVideo) {
            const joined = await prisma.participant.count({ where: { sessionId: session.id } });

            if (joined > 0) {
                return errorResponse(
                    res,
                    409,
                    `Players have already joined this lobby ${session.liveVideo ? 'with' : 'without'} live video. Host it the same way, or wait until it ends.`
                );
            }

            await prisma.quizSession.update({
                where: { id: session.id },
                data: { status: 'CANCELLED', endedAt: new Date() }
            });
            session = undefined;
        }

        if (!session) {
            session = await prisma.quizSession.create({
                data: {
                    quizId: quizId as string,
                    status: 'WAITING',
                    liveVideo
                }
            })
        }

        return res.status(200).json({
            sessonId: session.id,
            liveVideo: session.liveVideo,
        });

    } catch (error) {
        console.log("Start quiz session error: ", error);
        return errorResponse(res, 500, "Internal Server Error")

    }
}






// deleting question from a quiz
export const deleteQuestionController = async (req: Request, res: Response) => {
    try {
        const { quizId, questionId } = req.params;

        if (!questionId || typeof questionId !== 'string' || !questionId.trim()) {
            return errorResponse(res, 400, "Question ID is required");
        }

        const question = await prisma.question.findUnique({
            where: { id: questionId as string },
            include: {
                quiz: {
                    include: {
                        quizOrganizers: {
                            where: {
                                userId: req.userId,
                                inviteStatus: 'ACCEPTED'
                            }
                        }
                    }
                }
            }
        });

        if (!question) {
            return errorResponse(res, 404, "Question not found");
        }

        if (quizId && question.quizId !== quizId) {
            return errorResponse(res, 404, "Question not found in this quiz");
        }

        const isOrganizer = question.quiz.quizOrganizers.length > 0;
        const isCreator = question.quiz.creatorId === req.userId;

        if (!isOrganizer && !isCreator) {
            return errorResponse(res, 403, "You don't have access to this quiz");
        }

        await prisma.question.delete({
            where: { id: questionId as string }
        });

        return res.status(200).json({
            success: true,
            message: "Question deleted successfully"
        });

    } catch (error) {
        console.log("Delete question error: ", error);
        return errorResponse(res, 500, "Internal Server Error");
    }
}
