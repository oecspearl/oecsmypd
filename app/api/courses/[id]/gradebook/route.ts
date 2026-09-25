import { NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { hasRole } from "@/lib/rbac";
import { getCourseAccess } from "@/lib/course-access";
import { forbidden, notFound, serverError, unauthorized } from "@/lib/api-errors";

/**
 * Fetch question points for many quizzes in one query and group in memory.
 * Returns a map quizId -> total points (quizzes with no questions map to 0).
 */
async function fetchQuizTotalPoints(supabase: any, quizIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const ids = Array.from(new Set(quizIds.filter(Boolean)));
  if (ids.length === 0) return totals;

  const { data: questions, error } = await supabase
    .from("questions")
    .select("quiz_id, points")
    .in("quiz_id", ids);

  if (error || !questions) {
    console.error('Failed to fetch questions for quiz points calculation:', error);
    return totals;
  }

  for (const q of questions as Array<{ quiz_id: string; points: unknown }>) {
    totals.set(q.quiz_id, (totals.get(q.quiz_id) ?? 0) + Number(q.points ?? 0));
  }
  return totals;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: courseId } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const supabase = await createServerSupabaseClient();

    // Check if user has access to this course. Managers (admins, owner,
    // co-instructors) and curriculum designers see every student; enrolled
    // students see only their own rows.
    const access = await getCourseAccess(user.id, user.role, courseId);
    if (!access.courseExists) return notFound("Course not found");

    const isAdmin = hasRole(user.role, ["admin", "super_admin", "curriculum_designer"]);
    const isManager = access.canManage || isAdmin;
    const isEnrolled = !isManager && access.role === "student" && access.canView;

    if (!isManager && !isEnrolled) {
      return forbidden("Access denied. You must be enrolled in this course, be an instructor, or be an administrator to view the gradebook.");
    }

    // Get course information
    const { data: course, error: courseError } = await createServiceSupabaseClient()
      .from("courses")
      .select("id, title, description")
      .eq("id", courseId)
      .maybeSingle();

    if (courseError || !course) {
      return notFound("Course not found");
    }

    // Get enrolled students (only if instructor/admin)
    let students = [];
    if (isManager) {
      const { data: enrollments, error: enrollmentError } = await supabase
        .from("enrollments")
        .select(`
          student_id,
          users!enrollments_student_id_fkey(id, name, email)
        `)
        .eq("course_id", courseId)
        .eq("status", "active");

      if (!enrollmentError && enrollments) {
        students = enrollments.map(e => {
          const u = (Array.isArray(e.users) ? e.users[0] : e.users) as any;
          return {
            id: u?.id,
            name: u?.name,
            email: u?.email
          };
        });
      }
    }

    // Get grade items (try multiple approaches)
    // For students, use service client to avoid RLS infinite recursion issues
    const clientToUse = isEnrolled
      ? createServiceSupabaseClient()
      : supabase;
    
    let { data: gradeItems, error: itemsError } = await clientToUse
      .from("course_grade_items")
      .select("*")
      .eq("course_id", courseId)
      .eq("is_active", true)
      .order("created_at", { ascending: true });

    // If is_active column doesn't exist or table doesn't exist, try fallback approaches
    if (itemsError) {
      console.log('Grade items query failed, trying fallback approaches:', itemsError);
      
      // Try 1: Get all items without is_active filter, then filter manually
      const fallback1 = await clientToUse
        .from("course_grade_items")
        .select("*")
        .eq("course_id", courseId)
        .order("created_at", { ascending: true });
      
      if (!fallback1.error && fallback1.data && fallback1.data.length > 0) {
        console.log('Fallback 1 successful: found items without is_active filter');
        gradeItems = fallback1.data;
        itemsError = null;
      } else {
        console.log('Fallback 1 failed:', fallback1.error);
        
        // Try 2: Check if table exists at all
        const tableCheck = await clientToUse
          .from("course_grade_items")
          .select("id")
          .limit(1);
        
        if (tableCheck.error) {
          console.log('Table does not exist or has no data:', tableCheck.error);
          gradeItems = [];
          itemsError = null; // Don't treat this as an error, just empty result
        } else {
          console.log('Table exists but no items found for this course');
          gradeItems = [];
          itemsError = null;
        }
      }
    }

    if (itemsError) {
      return serverError("Failed to fetch grade items", itemsError);
    }

    // Filter out grade items for deleted quizzes and assignments
    // Also update quiz grade items with correct points calculated from questions
    if (gradeItems && gradeItems.length > 0) {
      // Get quiz IDs that need to be verified
      const quizIds = gradeItems
        .filter(item => item.type === 'quiz' && item.assessment_id)
        .map(item => item.assessment_id)
        .filter((id): id is string => !!id);
      
      // Update quiz grade items with correct points calculated from questions
      if (quizIds.length > 0) {
        // One query for every quiz's questions, grouped in memory.
        const quizPoints = await fetchQuizTotalPoints(clientToUse, quizIds);

        const updatePromises = gradeItems
          .filter(item => item.type === 'quiz' && item.assessment_id && quizIds.includes(item.assessment_id))
          .map(async (item: any) => {
            const calculatedPoints = quizPoints.get(item.assessment_id) ?? 0;
            const currentPoints = Number(item.points || 0);
            
            // Only update if calculated points are different and greater than 0
            if (calculatedPoints > 0 && currentPoints !== calculatedPoints) {
              console.log(`Updating grade item ${item.id} points from ${currentPoints} to ${calculatedPoints} for quiz ${item.assessment_id}`);
              const { error: updateError } = await clientToUse
                .from("course_grade_items")
                .update({ points: calculatedPoints, updated_at: new Date().toISOString() })
                .eq("id", item.id);
              
              if (!updateError) {
                item.points = calculatedPoints;
                
                // Update all existing grades for this grade item with new max_score and recalculated percentage
                const { data: existingGrades, error: gradesError } = await clientToUse
                  .from("course_grades")
                  .select("id, score")
                  .eq("grade_item_id", item.id);
                
                if (!gradesError && existingGrades && existingGrades.length > 0) {
                  const gradeUpdates = existingGrades.map((grade: any) => {
                    const newPercentage = calculatedPoints > 0 ? (Number(grade.score) / calculatedPoints) * 100 : 0;
                    return {
                      id: grade.id,
                      max_score: calculatedPoints,
                      percentage: Number(newPercentage.toFixed(2)),
                      updated_at: new Date().toISOString()
                    };
                  });
                  
                  // Update all grades in batch
                  for (const update of gradeUpdates) {
                    await clientToUse
                      .from("course_grades")
                      .update({
                        max_score: update.max_score,
                        percentage: update.percentage,
                        updated_at: update.updated_at
                      })
                      .eq("id", update.id);
                  }
                  
                  console.log(`Updated ${gradeUpdates.length} existing grades for grade item ${item.id} with new max_score ${calculatedPoints}`);
                }
              } else {
                console.error(`Failed to update grade item ${item.id}:`, updateError);
              }
            }
          });
        
        // Wait for all updates to complete (but don't fail if some fail)
        await Promise.allSettled(updatePromises);
        
        // Re-fetch grade items to ensure we have the updated points values
        const { data: refreshedGradeItems, error: refreshError } = await clientToUse
          .from("course_grade_items")
          .select("*")
          .eq("course_id", courseId)
          .eq("is_active", true)
          .order("created_at", { ascending: true });
        
        if (!refreshError && refreshedGradeItems) {
          gradeItems = refreshedGradeItems;
        }
      }

      // Get assignment IDs that need to be verified
      const assignmentIds = gradeItems
        .filter(item => item.type === 'assignment' && item.assessment_id)
        .map(item => item.assessment_id)
        .filter((id): id is string => !!id);

      const existingQuizIds = new Set<string>();
      const existingAssignmentIds = new Set<string>();
      let quizQueryFailed = false;
      let assignmentQueryFailed = false;

      // Only query if there are IDs to check
      // Use the same client to avoid RLS issues for students
      if (quizIds.length > 0) {
        const { data: existingQuizzes, error: quizQueryError } = await clientToUse
          .from("quizzes")
          .select("id")
          .in("id", quizIds);

        if (quizQueryError) {
          console.error('[Gradebook API] Quiz existence check failed:', quizQueryError);
          quizQueryFailed = true;
        } else if (existingQuizzes) {
          existingQuizzes.forEach(q => existingQuizIds.add(q.id));
          console.log('[Gradebook API] Found', existingQuizzes.length, 'existing quizzes out of', quizIds.length, 'grade items');
        }
      }

      if (assignmentIds.length > 0) {
        const { data: existingAssignments, error: assignmentQueryError } = await clientToUse
          .from("assignments")
          .select("id")
          .in("id", assignmentIds);

        if (assignmentQueryError) {
          console.error('[Gradebook API] Assignment existence check failed:', assignmentQueryError);
          assignmentQueryFailed = true;
        } else if (existingAssignments) {
          existingAssignments.forEach(a => existingAssignmentIds.add(a.id));
          console.log('[Gradebook API] Found', existingAssignments.length, 'existing assignments out of', assignmentIds.length, 'grade items');
        }
      }

      // Get discussion IDs that need to be verified
      const discussionIds = gradeItems
        .filter(item => item.type === 'discussion' && item.assessment_id)
        .map(item => item.assessment_id)
        .filter((id): id is string => !!id);

      const existingDiscussionIds = new Set<string>();
      let discussionQueryFailed = false;

      if (discussionIds.length > 0) {
        const { data: existingDiscussions, error: discussionQueryError } = await clientToUse
          .from("course_discussions")
          .select("id")
          .in("id", discussionIds);

        if (discussionQueryError) {
          console.error('[Gradebook API] Discussion existence check failed:', discussionQueryError);
          discussionQueryFailed = true;
        } else if (existingDiscussions) {
          existingDiscussions.forEach(d => existingDiscussionIds.add(d.id));
          console.log('[Gradebook API] Found', existingDiscussions.length, 'existing discussions out of', discussionIds.length, 'grade items');
        }
      }

      // Filter out items for deleted quizzes/assignments/discussions
      // SAFEGUARD: If the query failed, don't filter out items (keep them to avoid data loss)
      const originalCount = gradeItems.length;
      gradeItems = gradeItems.filter(item => {
        // If it's a quiz type and has an assessment_id, check if quiz exists
        if (item.type === 'quiz' && item.assessment_id) {
          // If query failed, keep the item (don't accidentally filter out valid items)
          if (quizQueryFailed) return true;
          return existingQuizIds.has(item.assessment_id);
        }
        // If it's an assignment type and has an assessment_id, check if assignment exists
        if (item.type === 'assignment' && item.assessment_id) {
          // If query failed, keep the item (don't accidentally filter out valid items)
          if (assignmentQueryFailed) return true;
          return existingAssignmentIds.has(item.assessment_id);
        }
        // If it's a discussion type and has an assessment_id, check if discussion exists
        if (item.type === 'discussion' && item.assessment_id) {
          // If query failed, keep the item (don't accidentally filter out valid items)
          if (discussionQueryFailed) return true;
          return existingDiscussionIds.has(item.assessment_id);
        }
        // For other types or items without assessment_id, keep them
        return true;
      });

      if (gradeItems.length !== originalCount) {
        console.log('[Gradebook API] Filtered out', originalCount - gradeItems.length, 'orphaned grade items');
      }
    }

    // Get all quizzes and assignments for this course (from lessons and direct course_id)
    // Use the same client as grade items to avoid RLS issues for students
    const { data: lessons, error: lessonsError } = await clientToUse
      .from("lessons")
      .select("id, title")
      .eq("course_id", courseId);

    let courseQuizzes = [];
    let courseAssignments = [];
    
    // Get quizzes linked through lessons
    if (!lessonsError && lessons && lessons.length > 0) {
      const lessonIds = lessons.map(l => l.id);
      
      // Get quizzes from lessons
      const { data: lessonQuizzes, error: lessonQuizzesError } = await clientToUse
        .from("quizzes")
        .select("*")
        .in("lesson_id", lessonIds)
        .order("created_at", { ascending: true });

      if (!lessonQuizzesError && lessonQuizzes) {
        // Map quizzes to include lesson information and activation status
        const lessonQuizList = lessonQuizzes.map(quiz => {
          const lesson = lessons.find(l => l.id === quiz.lesson_id);
          return {
            ...quiz,
            lesson_title: lesson?.title || 'Unknown Lesson',
            is_activated: gradeItems?.some(item => item.assessment_id === quiz.id && item.type === 'quiz') || false
          };
        });
        courseQuizzes = [...courseQuizzes, ...lessonQuizList];
      }
    }

    // Get quizzes with direct course_id
    const { data: directQuizzes, error: directQuizzesError } = await clientToUse
      .from("quizzes")
      .select("*")
      .eq("course_id", courseId)
      .order("created_at", { ascending: true });

    if (!directQuizzesError && directQuizzes) {
      // Map direct quizzes to include activation status
      const directQuizList = directQuizzes.map(quiz => ({
        ...quiz,
        lesson_title: 'Direct Course Quiz',
        is_activated: gradeItems?.some(item => item.assessment_id === quiz.id && item.type === 'quiz') || false
      }));
      courseQuizzes = [...courseQuizzes, ...directQuizList];
    }

    // Deduplicate quizzes by ID (a quiz may appear via lesson and direct course link)
    if (courseQuizzes.length > 0) {
      const uniqueById = new Map<string, typeof courseQuizzes[number]>();
      for (const q of courseQuizzes) {
        uniqueById.set(q.id, q);
      }
      courseQuizzes = Array.from(uniqueById.values());
    }

    // Get assignments from lessons
    if (!lessonsError && lessons && lessons.length > 0) {
      const lessonIds = lessons.map(l => l.id);
      
      const { data: lessonAssignments, error: lessonAssignmentsError } = await clientToUse
        .from("assignments")
        .select("*")
        .in("lesson_id", lessonIds)
        .order("created_at", { ascending: true });

      if (!lessonAssignmentsError && lessonAssignments) {
        // Map assignments to include lesson information
        const lessonAssignmentList = lessonAssignments.map(assignment => {
          const lesson = lessons.find(l => l.id === assignment.lesson_id);
          return {
            ...assignment,
            lesson_title: lesson?.title || 'Unknown Lesson',
            is_activated: gradeItems?.some(item => item.assessment_id === assignment.id && item.type === 'assignment') || false
          };
        });
        courseAssignments = [...courseAssignments, ...lessonAssignmentList];
      }
    }

    // Get assignments with direct course_id
    const { data: directAssignments, error: directAssignmentsError } = await clientToUse
      .from("assignments")
      .select("*")
      .eq("course_id", courseId)
      .order("created_at", { ascending: true });

    if (!directAssignmentsError && directAssignments) {
      // Map direct assignments to include activation status
      const directAssignmentList = directAssignments.map(assignment => ({
        ...assignment,
        lesson_title: 'Direct Course Assignment',
        is_activated: gradeItems?.some(item => item.assessment_id === assignment.id && item.type === 'assignment') || false
      }));
      courseAssignments = [...courseAssignments, ...directAssignmentList];
    }

    // Deduplicate assignments by ID
    if (courseAssignments.length > 0) {
      const uniqueById = new Map<string, typeof courseAssignments[number]>();
      for (const a of courseAssignments) {
        uniqueById.set(a.id, a);
      }
      courseAssignments = Array.from(uniqueById.values());
    }

    // Get graded discussions for this course
    let courseDiscussions: any[] = [];
    const { data: gradedDiscussions, error: discussionsError } = await clientToUse
      .from("course_discussions")
      .select("*")
      .eq("course_id", courseId)
      .eq("is_graded", true)
      .order("created_at", { ascending: true });

    if (!discussionsError && gradedDiscussions) {
      courseDiscussions = gradedDiscussions.map(discussion => ({
        ...discussion,
        is_activated: gradeItems?.some(item => item.assessment_id === discussion.id && item.type === 'discussion') || false
      }));
    }

    // Get grades - ensure we only get grades for grade items in this course
    let grades = [];
    
    // First, get all grade item IDs for this course
    const gradeItemIds = gradeItems?.map(item => item.id) || [];
    
    if (gradeItemIds.length > 0) {
      if (isManager) {
        const { data: gradeData, error: gradesError } = await supabase
          .from("course_grades")
          .select(`
            *,
            grade_item:course_grade_items(title, type, category, points, course_id)
          `)
          .eq("course_id", courseId)
          .in("grade_item_id", gradeItemIds);

        if (!gradesError && gradeData) {
          // Filter to ensure grade items belong to this course (double-check)
          grades = gradeData.filter((grade: any) => 
            grade.grade_item && grade.grade_item.course_id === courseId
          );
        }
      } else if (isEnrolled) {
        // Students can only see their own grades
        // Use service client for students to avoid RLS issues
        const studentClient = createServiceSupabaseClient();
        const { data: gradeData, error: gradesError } = await studentClient
          .from("course_grades")
          .select(`
            *,
            grade_item:course_grade_items(title, type, category, points, course_id)
          `)
          .eq("course_id", courseId)
          .eq("student_id", user.id)
          .in("grade_item_id", gradeItemIds);

        if (!gradesError && gradeData) {
          // Filter to ensure grade items belong to this course (double-check)
          grades = gradeData.filter((grade: any) => 
            grade.grade_item && grade.grade_item.course_id === courseId
          );
        }
      }
    }

    // For students, ensure gradebook items include all published quizzes and assignments
    // This ensures the student gradebook matches what they see in the dashboard
    if (isEnrolled) {
      // Get existing grade item assessment IDs
      const existingQuizItemIds = new Set(
        (gradeItems || [])
          .filter((item: any) => item.type === 'quiz' && item.assessment_id)
          .map((item: any) => item.assessment_id)
      );
      
      const existingAssignmentItemIds = new Set(
        (gradeItems || [])
          .filter((item: any) => item.type === 'assignment' && item.assessment_id)
          .map((item: any) => item.assessment_id)
      );
      
      // Find published quizzes that aren't in gradebook yet
      const missingQuizzes = (courseQuizzes || []).filter((q: any) => 
        q.published === true && !existingQuizItemIds.has(q.id)
      );
      
      // Find published assignments that aren't in gradebook yet
      const missingAssignments = (courseAssignments || []).filter((a: any) => 
        a.published === true && !existingAssignmentItemIds.has(a.id)
      );
      
      // Create grade items for missing published quizzes and assignments
      const newGradeItems: any[] = [];
      
      if (missingQuizzes.length > 0) {
        // Calculate points for each quiz from questions (one batched query)
        const missingQuizPoints = await fetchQuizTotalPoints(
          clientToUse,
          missingQuizzes.map((q: any) => q.id)
        );
        const quizItems = missingQuizzes.map((quiz: any) => {
          // Calculate actual total points from questions (not from quiz.points field)
          const totalPoints = missingQuizPoints.get(quiz.id) ?? 0;
          const pointsToUse = totalPoints > 0 ? totalPoints : (quiz.points || 100);
          
          return {
            course_id: courseId,
            title: quiz.title,
            type: 'quiz',
            category: 'Quizzes',
            points: pointsToUse,
            assessment_id: quiz.id,
            due_date: quiz.due_date,
            weight: 1.0,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
        });
        
        newGradeItems.push(...quizItems);
      }
      
      if (missingAssignments.length > 0) {
        const assignmentItems = missingAssignments.map((assignment: any) => ({
          course_id: courseId,
          title: assignment.title,
          type: 'assignment',
          category: 'Assignments',
          points: assignment.points || 100,
          assessment_id: assignment.id,
          due_date: assignment.due_date,
          weight: 1.0,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }));
        newGradeItems.push(...assignmentItems);
      }
      
      // Insert new grade items if any (use service client to bypass RLS)
      if (newGradeItems.length > 0) {
        const serviceSupabase = createServiceSupabaseClient();
        const { data: insertedItems, error: insertError } = await serviceSupabase
          .from("course_grade_items")
          .insert(newGradeItems)
          .select();
        
        if (!insertError && insertedItems) {
          gradeItems = [...(gradeItems || []), ...insertedItems];
          
          // Re-fetch grades with updated grade items (use service client for students)
          const updatedGradeItemIds = gradeItems.map((item: any) => item.id);
          if (updatedGradeItemIds.length > 0) {
            const { data: updatedGradeData, error: updatedGradesError } = await serviceSupabase
              .from("course_grades")
              .select(`
                *,
                grade_item:course_grade_items(title, type, category, points, course_id)
              `)
              .eq("course_id", courseId)
              .eq("student_id", user.id)
              .in("grade_item_id", updatedGradeItemIds);

            if (!updatedGradesError && updatedGradeData) {
              grades = updatedGradeData.filter((grade: any) => 
                grade.grade_item && grade.grade_item.course_id === courseId
              );
            }
          }
        } else if (insertError) {
          console.error('[Gradebook] Error auto-creating grade items for student:', insertError);
          // Don't fail - just log the error
        }
      }
    }

    // Get gradebook settings
    const { data: settings, error: settingsError } = await supabase
      .from("course_gradebook_settings")
      .select("*")
      .eq("course_id", courseId)
      .single();

    // Get gradebook statistics
    let stats = null;
    try {
      const { data: statsData, error: statsError } = await supabase
        .rpc('get_gradebook_stats', { target_course_id: courseId });
      
      if (!statsError && statsData && statsData.length > 0) {
        stats = statsData[0];
      }
    } catch (error) {
      console.log('Stats function not available, using fallback calculation');
      // Fallback calculation if function doesn't exist
      stats = {
        total_students: students.length,
        active_grade_items: gradeItems?.filter((item: any) => item.is_active !== false).length || 0,
        inactive_grade_items: gradeItems?.filter((item: any) => item.is_active === false).length || 0,
        total_grades: grades.length,
        courses_with_orphaned_items: 0
      };
    }

    return NextResponse.json({
      course,
      students,
      items: gradeItems || [],
      grades: grades || [],
      settings: settings || null,
      quizzes: courseQuizzes || [],
      assignments: courseAssignments || [],
      discussions: courseDiscussions || [],
      stats: stats
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });

  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
