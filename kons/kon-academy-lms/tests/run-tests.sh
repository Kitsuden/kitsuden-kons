#!/bin/bash

# Usage: ./run-tests.sh [API_URL] [SESSION_COOKIE]
API_URL=${1:-"http://localhost:3001"}
COOKIE=${2:-""}

echo "=========================================="
echo "Testing Kon Academy LMS in: $API_URL"
echo "=========================================="

if [ -z "$COOKIE" ]; then
  echo "⚠️  Warning: You did not pass a session cookie."
  echo "Tests requiring authentication (almost all of them) will fail with 401."
  echo "Usage: ./run-tests.sh http://localhost:3001 'better-auth.session_token=YOUR_TOKEN'"
  echo "------------------------------------------"
  read -p "Press Enter to continue anyway or Ctrl+C to cancel..."
fi

# Function to print responses nicely
test_endpoint() {
  local method=$1
  local endpoint=$2
  local data=$3
  local desc=$4

  echo -e "\n👉 \033[1;34m$desc\033[0m ($method $endpoint)"
  
  if [ "$method" == "GET" ] || [ "$method" == "DELETE" ]; then
    curl -s -X "$method" "$API_URL/api/academy$endpoint" \
      -H "Cookie: $COOKIE" \
      -H "Content-Type: application/json" | jq .
  else
    curl -s -X "$method" "$API_URL/api/academy$endpoint" \
      -H "Cookie: $COOKIE" \
      -H "Content-Type: application/json" \
      -d "$data" | jq .
  fi
}

# 1. Create a Course
echo "Creating test course..."
COURSE_RES=$(curl -s -X POST "$API_URL/api/academy/courses" \
  -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Course in Bash",
    "description": "Created automatically via script",
    "courseType": "self_paced",
    "durationHours": 5,
    "active": true
  }')

echo $COURSE_RES | jq .
COURSE_ID=$(echo $COURSE_RES | jq -r '.course.id // empty')

if [ -z "$COURSE_ID" ]; then
  echo "❌ Failed to create the course. Stopping tests (Verify your session cookie or permissions)."
  exit 1
fi

echo "✅ Course created with ID: $COURSE_ID"

# 2. List courses
test_endpoint "GET" "/courses" "" "Listing courses"

# 3. Get course detail
test_endpoint "GET" "/courses/$COURSE_ID" "" "Getting created course detail"

# 4. Create a module inside the course
echo -e "\n👉 \033[1;34mCreating Module 1\033[0m"
MOD_RES=$(curl -s -X POST "$API_URL/api/academy/courses/$COURSE_ID/modules" \
  -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Module 1: Introduction",
    "order": 1
  }')
echo $MOD_RES | jq .
MOD_ID=$(echo $MOD_RES | jq -r '.module.id // empty')

# 5. Create a topic inside the module
if [ -n "$MOD_ID" ]; then
  test_endpoint "POST" "/modules/$MOD_ID/topics" '{
    "title": "Topic 1.1: Welcome",
    "content": "<p>Hello world</p>",
    "videoType": "youtube",
    "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "durationMinutes": 10,
    "order": 1
  }' "Creating Topic inside the Module"
fi

# 6. Create an exam for the course
test_endpoint "POST" "/courses/$COURSE_ID/exam" '{
  "title": "Final Exam",
  "timeLimitMinutes": 30,
  "maxAttempts": 2,
  "minPassScore": 70,
  "questions": [
    {
      "questionText": "What color is the sky?",
      "questionType": "multiple",
      "points": 10,
      "options": [
        { "optionText": "Blue", "isCorrect": true },
        { "optionText": "Green", "isCorrect": false }
      ]
    }
  ]
}' "Creating Exam for the Course"

# 7. View Metrics (Reports)
test_endpoint "GET" "/reports/dashboard" "" "Viewing Metrics Dashboard"

# 8. Cleanup (Delete test course)
test_endpoint "DELETE" "/courses/$COURSE_ID" "" "Deleting test course (Cleanup)"

echo -e "\n🎉 Tests finished."
